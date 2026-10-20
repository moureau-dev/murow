import { GpuBindGroupLayout, GpuShader } from 'murow/gpu';
import { d, std } from '../gpu-ns';


import { tonemap } from '../shaders/utils';
import { call, f32 as f32Type, vec as vecType } from 'murow/gpu/ir';
import { ShaderValue, toExpr, type ShaderInput } from 'murow/gpu/dsl';
import { createTexturedMeshVertex, type MeshDataLayout } from '../shader';

import { ShadowUniforms } from '../shadows';
import { SpotShadowUniforms } from '../shadows/spot-shadow-system';
import { PointShadowUniforms } from '../shadows/point-shadow-system';

/**
 * Uniform block shared by all engine-provided materials. f32-only to keep the
 * layout contiguous and avoid vec alignment padding.
 */
export const EngineMaterialUniforms = d.struct({
    colorR: d.f32,
    colorG: d.f32,
    colorB: d.f32,
    opacity: d.f32,
    emissive: d.f32,
    alphaTest: d.f32,
    uvScaleU: d.f32,
    uvScaleV: d.f32,
    uvOffsetU: d.f32,
    uvOffsetV: d.f32,
    /** 0 = ignore the shadow map, 1 = sample it. */
    receiveShadow: d.f32,
    /** Object-space offset along the vertex normal (inverted-hull outline). */
    extrude: d.f32,
});

export function createEngineMaterialLayout() {
    return new GpuBindGroupLayout({
        material: { uniform: EngineMaterialUniforms },
        map: { texture: 'float' },
        mapSampler: { sampler: 'filtering' },
        shadow: { uniform: ShadowUniforms },
        shadowMap: { texture: 'float' },
        shadowSampler: { sampler: 'filtering' },
        spotShadow: { uniform: SpotShadowUniforms },
        spotShadowMap: { texture: 'float', viewDimension: '2d-array' },
        spotSampler: { sampler: 'filtering' },
        pointShadow: { uniform: PointShadowUniforms },
        pointShadowMap: { texture: 'float', viewDimension: 'cube-array' },
        pointSampler: { sampler: 'filtering' },
    });
}

export type EngineMaterialLayout = ReturnType<typeof createEngineMaterialLayout>;

/**
 * Uniform block shared by every PBR material. f32-only to keep the layout
 * contiguous and avoid vec alignment padding.
 */
export const PbrMaterialUniforms = d.struct({
    colorR: d.f32,
    colorG: d.f32,
    colorB: d.f32,
    opacity: d.f32,
    alphaTest: d.f32,
    uvScaleU: d.f32,
    uvScaleV: d.f32,
    uvOffsetU: d.f32,
    uvOffsetV: d.f32,
    /** 0 = ignore the shadow map, 1 = sample it. */
    receiveShadow: d.f32,
    metallic: d.f32,
    roughness: d.f32,
    occlusionStrength: d.f32,
    emissiveR: d.f32,
    emissiveG: d.f32,
    emissiveB: d.f32,
    /** 0 = use the metallic/roughness factors, 1 = sample the map. */
    hasMetallicRoughness: d.f32,
});

export function createPbrMaterialLayout() {
    return new GpuBindGroupLayout({
        material: { uniform: PbrMaterialUniforms },
        baseColorMap: { texture: 'float' },
        baseColorSampler: { sampler: 'filtering' },
        metallicRoughnessMap: { texture: 'float' },
        metallicRoughnessSampler: { sampler: 'filtering' },
        occlusionMap: { texture: 'float' },
        occlusionSampler: { sampler: 'filtering' },
        emissiveMap: { texture: 'float' },
        emissiveSampler: { sampler: 'filtering' },
        shadow: { uniform: ShadowUniforms },
        shadowMap: { texture: 'float' },
        shadowSampler: { sampler: 'filtering' },
        spotShadow: { uniform: SpotShadowUniforms },
        spotShadowMap: { texture: 'float', viewDimension: '2d-array' },
        spotSampler: { sampler: 'filtering' },
        pointShadow: { uniform: PointShadowUniforms },
        pointShadowMap: { texture: 'float', viewDimension: 'cube-array' },
        pointSampler: { sampler: 'filtering' },
    });
}

export type PbrMaterialLayout = ReturnType<typeof createPbrMaterialLayout>;


type FragInput = {
    vNormal: { x: number; y: number; z: number };
    vColor: { x: number; y: number; z: number };
    vUV: { x: number; y: number };
    vWorldPos: { x: number; y: number; z: number };
    frontFacing: boolean;
    /** Fragment coordinates (pixels); divide by `scene.resolution*` for screen UV. */
    position: { x: number; y: number; z: number; w: number };
};

export function createStandardMaterialFragment(meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    return GpuShader.fragment(
        {
            in: { vMorph: d.f32, vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position },
            out: d.vec4f,
            bindings: { mesh: meshLayout, mat: matLayout },
            helpers: { std, tonemap },
        },
        (input, { mesh, mat }) => {
        // LOD dithered cross-fade — discarded pixels skip all shading below.
        const lodMorph = input.vMorph;
        if (lodMorph > 0.0) {
            const lodDither = std.fract(std.sin(input.position.x * 12.9898 + input.position.y * 78.233) * 43758.5453);
            if (lodMorph < 1.0) { if (lodDither < lodMorph) { std.discard(); } }
            else { if (lodDither >= lodMorph - 1.0) { std.discard(); } }
        }

        const u = mesh.uniforms;
        const m = mat.material;
        const uv = d.vec2f(input.vUV.x * m.uvScaleU + m.uvOffsetU, input.vUV.y * m.uvScaleV + m.uvOffsetV);
        const tex = std.textureSample(mat.map, mat.mapSampler, uv);
        const baseColor = d.vec3f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
        );
        const worldPos = input.vWorldPos;
        // Flip the normal on back faces so double-sided/unculled surfaces light correctly.
        const normal = std.mul(
            std.normalize(input.vNormal),
            std.select(d.vec3f(-1.0, -1.0, -1.0), d.vec3f(1.0, 1.0, 1.0), input.frontFacing),
        );

        const lightDir = std.normalize(d.vec3f(u.lightDirX, u.lightDirY, u.lightDirZ));
        const diff = std.max(std.dot(normal, lightDir), 0.0) * u.lightDirIntensity;
        // `let`: the shadow branch below may attenuate this.
        let direct = std.mul(d.vec3f(u.lightDirR, u.lightDirG, u.lightDirB), diff);

        // Directional shadow (PCF). Uniform-gated so disabled materials/globals
        // skip sampling entirely. Taps are unrolled with explicitly f32-typed
        // offsets: numeric literals would otherwise infer i32.
        const shU = mat.shadow;
        if (m.receiveShadow > 0.5 && shU.params.x > 0.5) {
            // Normal-offset bias: push the sample point toward the light along
            // the surface normal, scaled by the grazing angle.
            const ndl = std.saturate(std.dot(normal, lightDir));
            const noff = shU.texelWorldSize * (1.0 - ndl) * 1.5;
            const sp = d.vec3f(
                worldPos.x + normal.x * noff,
                worldPos.y + normal.y * noff,
                worldPos.z + normal.z * noff,
            );
            const lp = std.mul(shU.viewProjection, d.vec4f(sp.x, sp.y, sp.z, 1.0));
            const ndc = d.vec3f(lp.x / lp.w, lp.y / lp.w, lp.z / lp.w);
            const suv = d.vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
            const sDepth = ndc.z * 0.5 + 0.5 - shU.params.y;
            // 2x2 PCF at half-texel offsets; the linear sampler makes each tap a
            // 2x2 bilinear average, so four taps cover a 3x3 neighbourhood.
            const t = shU.params.z * shU.params.w * 0.5;
            const one = d.f32(1.0);
            const zero = d.f32(0.0);
            const xn = d.f32(-1.0);
            const xp = d.f32(1.0);
            const s0 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xn, xn), t)), 0.0).x;
            const s1 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xp, xn), t)), 0.0).x;
            const s2 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xn, xp), t)), 0.0).x;
            const s3 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xp, xp), t)), 0.0).x;
            // select(falseValue, trueValue, cond): 1 when this tap is occluded.
            const occ = std.select(zero, one, sDepth > s0)
                + std.select(zero, one, sDepth > s1)
                + std.select(zero, one, sDepth > s2)
                + std.select(zero, one, sDepth > s3);
            const inside = std.select(zero, one, suv.x >= 0.0) * std.select(zero, one, suv.x <= 1.0)
                * std.select(zero, one, suv.y >= 0.0) * std.select(zero, one, suv.y <= 1.0);
            direct = std.mul(direct, 1.0 - (occ / 4.0) * inside);
        }

        let acc = d.vec3f(
            baseColor.x * (u.ambientR + direct.x),
            baseColor.y * (u.ambientG + direct.y),
            baseColor.z * (u.ambientB + direct.z),
        );

        const count = u.lightCount;
        const a = u.alpha;
        for (let i = d.u32(0); i < count; i++) {
            const L = mesh.lights[i];
            const c = std.shadeLight(
                {
                    pos: d.vec3f(std.mix(L.prevPosX, L.currPosX, a), std.mix(L.prevPosY, L.currPosY, a), std.mix(L.prevPosZ, L.currPosZ, a)),
                    dir: d.vec3f(std.mix(L.prevDirX, L.currDirX, a), std.mix(L.prevDirY, L.currDirY, a), std.mix(L.prevDirZ, L.currDirZ, a)),
                    color: d.vec3f(L.colorR, L.colorG, L.colorB),
                    intensity: L.intensity, range: L.range, innerCos: L.innerCos, outerCos: L.outerCos, kind: L.kind,
                },
                { normal, worldPos },
            );
            // Per-light shadow (scalar factor, so no vec reassignment).
            const oneF = d.f32(1.0);
            const zeroF = d.f32(0.0);
            let sh = std.select(oneF, oneF, L.castsShadow > 0.5);
            const lit = c.x + c.y + c.z;
            if (L.castsShadow > 0.5 && L.kind < 1.5 && lit > 0.0 && mat.pointShadow.params.x > 0.5) {
                // Point light: cube shadow, compare distance along the direction.
                const idx = d.i32(L.shadowMapIndex);
                const lp = mat.pointShadow.lights[idx];
                const dd = d.vec3f(worldPos.x - lp.x, worldPos.y - lp.y, worldPos.z - lp.z);
                const ddLen = std.max(std.length(dd), 1.0e-4);
                const pdir = std.mul(dd, 1.0 / ddLen);
                const s = std.textureSampleLevel(mat.pointShadowMap, mat.pointSampler, pdir, idx, 0.0).x * lp.w;
                sh = std.select(oneF, zeroF, ddLen - mat.pointShadow.params.y > s);
            } else if (L.castsShadow > 0.5 && lit > 0.0 && mat.spotShadow.params.x > 0.5) {
                // Spot light: project into the spot's shadow map, 4-tap PCF.
                const idx = d.i32(L.shadowMapIndex);
                const svp = mat.spotShadow.matrices[idx];
                const sp = std.mul(svp, d.vec4f(worldPos.x, worldPos.y, worldPos.z, 1.0));
                const sndc = d.vec3f(sp.x / sp.w, sp.y / sp.w, sp.z / sp.w);
                const suv = d.vec2f(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
                const lp = mat.spotShadow.lights[idx];
                // Stored depth is distance/far (linear), so compare distances.
                const rdep = std.length(d.vec3f(worldPos.x - lp.x, worldPos.y - lp.y, worldPos.z - lp.z)) / lp.w - mat.spotShadow.params.y;
                const st = mat.spotShadow.params.z * 0.5;
                const b0 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(-st, -st)), idx, 0.0).x;
                const b1 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(st, -st)), idx, 0.0).x;
                const b2 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(-st, st)), idx, 0.0).x;
                const b3 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(st, st)), idx, 0.0).x;
                const onc = std.select(zeroF, oneF, rdep > b0) + std.select(zeroF, oneF, rdep > b1) + std.select(zeroF, oneF, rdep > b2) + std.select(zeroF, oneF, rdep > b3);
                const inb = std.select(zeroF, oneF, suv.x >= 0.0) * std.select(zeroF, oneF, suv.x <= 1.0) * std.select(zeroF, oneF, suv.y >= 0.0) * std.select(zeroF, oneF, suv.y <= 1.0);
                sh = d.f32(1.0 - (onc / 4.0) * inb);
            }
            const cc = std.mul(c, sh);
            acc = d.vec3f(acc.x + baseColor.x * cc.x, acc.y + baseColor.y * cc.y, acc.z + baseColor.z * cc.z);
        }

        const alpha = std.mul(tex.w, m.opacity);
        if (alpha < m.alphaTest) { std.discard(); }

        const mapped = std.tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, alpha);
        },
    );
}

export function createPbrMaterialFragment(meshLayout: MeshDataLayout, matLayout: PbrMaterialLayout) {
    return GpuShader.fragment(
        {
            in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, vCustom: d.vec2f, vMorph: d.f32, frontFacing: d.builtin.frontFacing, position: d.builtin.position },
            out: d.vec4f,
            bindings: { mesh: meshLayout, mat: matLayout },
            helpers: { std, tonemap },
        },
        (input, { mesh, mat }) => {
        const lodMorph = input.vMorph;
        if (lodMorph > 0.0) {
            const lodDither = std.fract(std.sin(input.position.x * 12.9898 + input.position.y * 78.233) * 43758.5453);
            if (lodMorph < 1.0) { if (lodDither < lodMorph) { std.discard(); } }
            else { if (lodDither >= lodMorph - 1.0) { std.discard(); } }
        }

        const u = mesh.uniforms;
        const m = mat.material;
        const uv = d.vec2f(
            std.add(std.mul(input.vUV.x, m.uvScaleU), m.uvOffsetU),
            std.add(std.mul(input.vUV.y, m.uvScaleV), m.uvOffsetV),
        );

        const baseTex = std.textureSample(mat.baseColorMap, mat.baseColorSampler, uv);
        const mrTex = std.textureSample(mat.metallicRoughnessMap, mat.metallicRoughnessSampler, uv);
        const aoTex = std.textureSample(mat.occlusionMap, mat.occlusionSampler, uv);
        const emTex = std.textureSample(mat.emissiveMap, mat.emissiveSampler, uv);

        const baseColor = d.vec3f(
            std.mul(std.mul(baseTex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(baseTex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(baseTex.z, input.vColor.z), m.colorB),
        );
        const hasMap = m.hasMetallicRoughness > 0.5;
        const metallic = std.clamp(std.select(m.metallic, std.mul(mrTex.z, m.metallic), hasMap), d.f32(0.0), d.f32(1.0));
        const roughness = std.clamp(std.select(m.roughness, std.mul(mrTex.y, m.roughness), hasMap), d.f32(0.04), d.f32(1.0));
        const ao = std.mix(d.f32(1.0), aoTex.x, m.occlusionStrength);

        const worldPos = input.vWorldPos;
        const normal = std.mul(
            std.normalize(input.vNormal),
            std.select(d.vec3f(-1.0, -1.0, -1.0), d.vec3f(1.0, 1.0, 1.0), input.frontFacing),
        );
        const viewDir = std.normalize(d.vec3f(
            std.sub(u.cameraX, worldPos.x),
            std.sub(u.cameraY, worldPos.y),
            std.sub(u.cameraZ, worldPos.z),
        ));
        const NdotV = std.max(std.dot(normal, viewDir), d.f32(0.0001));
        const F0 = std.mix(d.vec3f(0.04, 0.04, 0.04), baseColor, metallic);
        const one = d.f32(1.0);
        const zero = d.f32(0.0);
        const PI = d.f32(3.14159265);

        // Directional sun.
        const sunDir = std.normalize(d.vec3f(u.lightDirX, u.lightDirY, u.lightDirZ));
        const sunH = std.normalize(std.add(viewDir, sunDir));
        const sunNdotL = std.max(std.dot(normal, sunDir), zero);
        const sunNdotH = std.max(std.dot(normal, sunH), zero);
        const sunVdotH = std.max(std.dot(viewDir, sunH), zero);

        const a = std.mul(roughness, roughness);
        const a2 = std.mul(a, a);
        const dDenom = std.add(std.mul(std.mul(sunNdotH, sunNdotH), std.sub(a2, one)), one);
        const D = std.div(a2, std.mul(PI, std.mul(dDenom, dDenom)));
        const k = std.div(std.pow(std.add(roughness, one), d.f32(2.0)), d.f32(8.0));
        const Gv = std.div(NdotV, std.add(std.mul(NdotV, std.sub(one, k)), k));
        const Gl = std.div(sunNdotL, std.add(std.mul(sunNdotL, std.sub(one, k)), k));
        const G = std.mul(Gv, Gl);
        const fresnel = std.pow(std.sub(one, sunVdotH), d.f32(5.0));
        const F = std.add(F0, std.mul(std.sub(d.vec3f(1.0, 1.0, 1.0), F0), fresnel));
        const specular = std.div(
            std.mul(D, std.mul(G, F)),
            std.add(std.mul(d.f32(4.0), std.mul(NdotV, sunNdotL)), d.f32(0.0001)),
        );
        const kd = std.mul(std.sub(d.vec3f(1.0, 1.0, 1.0), F), std.sub(one, metallic));
        const brdf = std.add(std.mul(kd, std.div(baseColor, PI)), specular);

        const sunColor = std.mul(
            d.vec3f(u.lightDirR, u.lightDirG, u.lightDirB),
            u.lightDirIntensity,
        );
        let direct = std.mul(std.mul(brdf, sunColor), sunNdotL);

        // Directional shadow (PCF).
        const shU = mat.shadow;
        if (m.receiveShadow > 0.5 && shU.params.x > 0.5) {
            const ndl = std.saturate(std.dot(normal, sunDir));
            const noff = shU.texelWorldSize * (1.0 - ndl) * 1.5;
            const sp = d.vec3f(
                worldPos.x + normal.x * noff,
                worldPos.y + normal.y * noff,
                worldPos.z + normal.z * noff,
            );
            const lp = std.mul(shU.viewProjection, d.vec4f(sp.x, sp.y, sp.z, 1.0));
            const ndc = d.vec3f(lp.x / lp.w, lp.y / lp.w, lp.z / lp.w);
            const suv = d.vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
            const sDepth = ndc.z * 0.5 + 0.5 - shU.params.y;
            const t = shU.params.z * shU.params.w * 0.5;
            const xn = d.f32(-1.0);
            const xp = d.f32(1.0);
            const s0 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xn, xn), t)), 0.0).x;
            const s1 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xp, xn), t)), 0.0).x;
            const s2 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xn, xp), t)), 0.0).x;
            const s3 = std.textureSampleLevel(mat.shadowMap, mat.shadowSampler, std.add(suv, std.mul(d.vec2f(xp, xp), t)), 0.0).x;
            const occ = std.select(zero, one, sDepth > s0)
                + std.select(zero, one, sDepth > s1)
                + std.select(zero, one, sDepth > s2)
                + std.select(zero, one, sDepth > s3);
            const inside = std.select(zero, one, suv.x >= 0.0) * std.select(zero, one, suv.x <= 1.0)
                * std.select(zero, one, suv.y >= 0.0) * std.select(zero, one, suv.y <= 1.0);
            direct = std.mul(direct, 1.0 - (occ / 4.0) * inside);
        }

        const ambient = d.vec3f(u.ambientR, u.ambientG, u.ambientB);
        const ambientDiffuse = std.mul(std.mul(baseColor, ambient), std.mul(ao, std.sub(one, metallic)));
        const ambientSpecular = std.mul(F0, std.mul(ambient, ao));
        let acc = std.add(std.add(ambientDiffuse, ambientSpecular), direct);

        // Point and spot lights.
        const count = u.lightCount;
        const alpha = u.alpha;
        for (let i = d.u32(0); i < count; i++) {
            const L = mesh.lights[i];
            const lightPos = d.vec3f(
                std.mix(L.prevPosX, L.currPosX, alpha),
                std.mix(L.prevPosY, L.currPosY, alpha),
                std.mix(L.prevPosZ, L.currPosZ, alpha),
            );
            const toLight = std.sub(lightPos, worldPos);
            const dist = std.length(toLight);
            const Ldir = std.normalize(toLight);
            const H = std.normalize(std.add(viewDir, Ldir));
            const NdotL = std.max(std.dot(normal, Ldir), zero);
            const NdotH = std.max(std.dot(normal, H), zero);
            const VdotH = std.max(std.dot(viewDir, H), zero);

            const aL = std.mul(roughness, roughness);
            const a2L = std.mul(aL, aL);
            const dDenomL = std.add(std.mul(std.mul(NdotH, NdotH), std.sub(a2L, one)), one);
            const DL = std.div(a2L, std.mul(PI, std.mul(dDenomL, dDenomL)));
            const kL = std.div(std.pow(std.add(roughness, one), d.f32(2.0)), d.f32(8.0));
            const GvL = std.div(NdotV, std.add(std.mul(NdotV, std.sub(one, kL)), kL));
            const GlL = std.div(NdotL, std.add(std.mul(NdotL, std.sub(one, kL)), kL));
            const GL = std.mul(GvL, GlL);
            const fresnelL = std.pow(std.sub(one, VdotH), d.f32(5.0));
            const FL = std.add(F0, std.mul(std.sub(d.vec3f(1.0, 1.0, 1.0), F0), fresnelL));
            const specularL = std.div(
                std.mul(DL, std.mul(GL, FL)),
                std.add(std.mul(d.f32(4.0), std.mul(NdotV, NdotL)), d.f32(0.0001)),
            );
            const kdL = std.mul(std.sub(d.vec3f(1.0, 1.0, 1.0), FL), std.sub(one, metallic));
            const brdfL = std.add(std.mul(kdL, std.div(baseColor, PI)), specularL);

            const isSpot = L.kind > 1.5;
            const atten = std.clamp(
                std.sub(one, std.div(dist, std.max(L.range, d.f32(0.0001)))),
                zero,
                one,
            );
            const axis = std.normalize(std.select(d.vec3f(0.0, 0.0, 1.0), d.vec3f(L.currDirX, L.currDirY, L.currDirZ), isSpot));
            const cosAngle = std.dot(axis, std.neg(Ldir));
            const cone = std.select(one, std.smoothstep(L.outerCos, L.innerCos, cosAngle), isSpot);

            const oneF = d.f32(1.0);
            const zeroF = d.f32(0.0);
            let sh = std.select(oneF, oneF, L.castsShadow > 0.5);
            if (L.castsShadow > 0.5 && NdotL > 0.0 && mat.pointShadow.params.x > 0.5) {
                const idx = d.i32(L.shadowMapIndex);
                const lp = mat.pointShadow.lights[idx];
                const dd = d.vec3f(worldPos.x - lp.x, worldPos.y - lp.y, worldPos.z - lp.z);
                const ddLen = std.max(std.length(dd), d.f32(0.0001));
                const pdir = std.mul(dd, d.f32(1.0) / ddLen);
                const s = std.textureSampleLevel(mat.pointShadowMap, mat.pointSampler, pdir, idx, 0.0).x * lp.w;
                sh = std.select(oneF, zeroF, ddLen - mat.pointShadow.params.y > s);
            } else if (L.castsShadow > 0.5 && NdotL > 0.0 && mat.spotShadow.params.x > 0.5) {
                const idx = d.i32(L.shadowMapIndex);
                const svp = mat.spotShadow.matrices[idx];
                const sp = std.mul(svp, d.vec4f(worldPos.x, worldPos.y, worldPos.z, 1.0));
                const sndc = d.vec3f(sp.x / sp.w, sp.y / sp.w, sp.z / sp.w);
                const suv = d.vec2f(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
                const lp = mat.spotShadow.lights[idx];
                const rdep = std.length(d.vec3f(worldPos.x - lp.x, worldPos.y - lp.y, worldPos.z - lp.z)) / lp.w - mat.spotShadow.params.y;
                const st = mat.spotShadow.params.z * 0.5;
                const b0 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(-st, -st)), idx, 0.0).x;
                const b1 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(st, -st)), idx, 0.0).x;
                const b2 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(-st, st)), idx, 0.0).x;
                const b3 = std.textureSampleLevel(mat.spotShadowMap, mat.spotSampler, std.add(suv, d.vec2f(st, st)), idx, 0.0).x;
                const onc = std.select(zeroF, oneF, rdep > b0) + std.select(zeroF, oneF, rdep > b1) + std.select(zeroF, oneF, rdep > b2) + std.select(zeroF, oneF, rdep > b3);
                const inb = std.select(zeroF, oneF, suv.x >= 0.0) * std.select(zeroF, oneF, suv.x <= 1.0) * std.select(zeroF, oneF, suv.y >= 0.0) * std.select(zeroF, oneF, suv.y <= 1.0);
                sh = d.f32(1.0 - (onc / 4.0) * inb);
            }

            const radiance = std.mul(
                d.vec3f(L.colorR, L.colorG, L.colorB),
                std.mul(L.intensity, std.mul(std.mul(atten, atten), cone)),
            );
            const contribution = std.mul(std.mul(brdfL, radiance), std.mul(NdotL, sh));
            acc = std.add(acc, contribution);
        }

        const emissive = std.mul(d.vec3f(m.emissiveR, m.emissiveG, m.emissiveB), d.vec3f(emTex.x, emTex.y, emTex.z));
        acc = std.add(acc, emissive);

        const alphaOut = std.mul(baseTex.w, m.opacity);
        if (alphaOut < m.alphaTest) { std.discard(); }

        const mapped = std.tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, alphaOut);
        },
    );
}

export function createUnlitMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    return GpuShader.fragment(
        {
            in: { vMorph: d.f32, vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, position: d.builtin.position },
            out: d.vec4f,
            bindings: { mat: matLayout },
        },
        (input, { mat }) => {
        const lodMorph = input.vMorph;
        if (lodMorph > 0.0) {
            const lodDither = std.fract(std.sin(input.position.x * 12.9898 + input.position.y * 78.233) * 43758.5453);
            if (lodMorph < 1.0) { if (lodDither < lodMorph) { std.discard(); } }
            else { if (lodDither >= lodMorph - 1.0) { std.discard(); } }
        }
        const m = mat.material;
        const uv = d.vec2f(input.vUV.x * m.uvScaleU + m.uvOffsetU, input.vUV.y * m.uvScaleV + m.uvOffsetV);
        const tex = std.textureSample(mat.map, mat.mapSampler, uv);
        const alpha = std.mul(tex.w, m.opacity);
        if (alpha < m.alphaTest) { std.discard(); }
        return d.vec4f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
            alpha,
        );
        },
    );
}

export function createEmissiveMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    return GpuShader.fragment(
        {
            in: { vMorph: d.f32, vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, position: d.builtin.position },
            out: d.vec4f,
            bindings: { mat: matLayout },
        },
        (input, { mat }) => {
        const lodMorph = input.vMorph;
        if (lodMorph > 0.0) {
            const lodDither = std.fract(std.sin(input.position.x * 12.9898 + input.position.y * 78.233) * 43758.5453);
            if (lodMorph < 1.0) { if (lodDither < lodMorph) { std.discard(); } }
            else { if (lodDither >= lodMorph - 1.0) { std.discard(); } }
        }
        const m = mat.material;
        const uv = d.vec2f(input.vUV.x * m.uvScaleU + m.uvOffsetU, input.vUV.y * m.uvScaleV + m.uvOffsetV);
        const tex = std.textureSample(mat.map, mat.mapSampler, uv);
        const baseColor = d.vec3f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
        );
        const alpha = std.mul(tex.w, m.opacity);
        if (alpha < m.alphaTest) { std.discard(); }
        return d.vec4f(
            std.mul(baseColor.x, m.emissive),
            std.mul(baseColor.y, m.emissive),
            std.mul(baseColor.z, m.emissive),
            alpha,
        );
        },
    );
}

/**
 * 3D value noise sampled from the shared noise texture (Hoskins trick: fold z
 * into a 2D lookup). Exposed to material shaders as the free variable `noise`.
 * Call it as `noise(d.vec3f(x, y, z))`.
 */
export function createNoiseFn(): (x: ShaderInput) => ShaderValue {
    return (x) => new ShaderValue({ node: call(vecType('f32', 3), 'noise', [toExpr(x)]) });
}

/**
 * Signed value noise in the style of trisomie21's fireball shader. Exposed to
 * material shaders as the free variable `snoise`. Call it as
 * `snoise(d.vec3f(x, y, z), d.f32(res))`; it returns a value in [-1, 1].
 */
export function createSnoiseFn(): (uv: ShaderInput, res: ShaderInput) => ShaderValue {
    return (uv, res) => new ShaderValue({ node: call(f32Type(), 'snoise', [toExpr(uv), toExpr(res)]) });
}

export { createTexturedMeshVertex };

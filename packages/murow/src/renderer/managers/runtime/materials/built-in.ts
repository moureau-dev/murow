import { GpuBindGroupLayout, GpuShader } from 'murow/gpu';
import { d, std } from '../gpu-ns';


import { lightContribution, tonemap } from '../shaders/utils';
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
            in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position },
            out: d.vec4f,
            bindings: { mesh: meshLayout, mat: matLayout },
            helpers: { lightContribution, tonemap },
        },
        (input, { mesh, mat }) => {
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
            const pos = d.vec3f(std.mix(L.prevPosX, L.currPosX, a), std.mix(L.prevPosY, L.currPosY, a), std.mix(L.prevPosZ, L.currPosZ, a));
            const axis = d.vec3f(std.mix(L.prevDirX, L.currDirX, a), std.mix(L.prevDirY, L.currDirY, a), std.mix(L.prevDirZ, L.currDirZ, a));
            const c = lightContribution(pos, axis, d.vec3f(L.colorR, L.colorG, L.colorB), d.vec4f(L.intensity, L.range, L.innerCos, L.outerCos), normal, worldPos);
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

        const mapped = tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, alpha);
        },
    );
}

export function createUnlitMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    return GpuShader.fragment(
        {
            in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f },
            out: d.vec4f,
            bindings: { mat: matLayout },
        },
        (input, { mat }) => {
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
            in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f },
            out: d.vec4f,
            bindings: { mat: matLayout },
        },
        (input, { mat }) => {
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

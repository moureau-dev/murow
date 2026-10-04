import { tgpu, d, std } from '../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import { lightContribution, tonemap } from '../../../shaders/utils';
import { createTexturedMeshVertex, type MeshDataLayout } from '../../shader';

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
    _pad0: d.f32,
    _pad1: d.f32,
});

export function createEngineMaterialLayout() {
    return tgpu.bindGroupLayout({
        material: { uniform: EngineMaterialUniforms },
        map: { texture: 'float' },
        mapSampler: { sampler: 'filtering' },
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
    const fn = function(input: FragInput) {
        const u = meshLayout.$.uniforms;
        const m = matLayout.$.material;
        const uv = d.vec2f(input.vUV.x * m.uvScaleU + m.uvOffsetU, input.vUV.y * m.uvScaleV + m.uvOffsetV);
        const tex = std.textureSample(matLayout.$.map, matLayout.$.mapSampler, uv);
        const baseColor = d.vec3f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
        );
        const worldPos = d.vec3f(input.vWorldPos.x, input.vWorldPos.y, input.vWorldPos.z);
        // Flip the normal on back faces so double-sided/unculled surfaces light correctly.
        const normal = std.mul(
            std.normalize(d.vec3f(input.vNormal.x, input.vNormal.y, input.vNormal.z)),
            std.select(-1.0, 1.0, input.frontFacing),
        );

        const lightDir = std.normalize(d.vec3f(u.lightDirX, u.lightDirY, u.lightDirZ));
        const diff = std.max(std.dot(normal, lightDir), 0.0) * u.lightDirIntensity;

        let acc = d.vec3f(
            baseColor.x * (u.ambientR + u.lightDirR * diff),
            baseColor.y * (u.ambientG + u.lightDirG * diff),
            baseColor.z * (u.ambientB + u.lightDirB * diff),
        );

        const count = u.lightCount;
        const a = u.alpha;
        for (let i = d.u32(0); i < count; i++) {
            const L = meshLayout.$.lights[i];
            const pos = d.vec3f(std.mix(L.prevPosX, L.currPosX, a), std.mix(L.prevPosY, L.currPosY, a), std.mix(L.prevPosZ, L.currPosZ, a));
            const axis = d.vec3f(std.mix(L.prevDirX, L.currDirX, a), std.mix(L.prevDirY, L.currDirY, a), std.mix(L.prevDirZ, L.currDirZ, a));
            const c = lightContribution(pos, axis, d.vec3f(L.colorR, L.colorG, L.colorB), d.vec4f(L.intensity, L.range, L.innerCos, L.outerCos), normal, worldPos);
            acc = d.vec3f(acc.x + baseColor.x * c.x, acc.y + baseColor.y * c.y, acc.z + baseColor.z * c.z);
        }

        const alpha = std.mul(tex.w, m.opacity);
        if (alpha < m.alphaTest) { std.discard(); }

        const mapped = tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, alpha);
    };
    attachShaderMetadata(fn as any, () => ({ d, std, meshLayout, matLayout, lightContribution, tonemap }), false, { d, std, meshLayout, matLayout });
    return tgpu.fragmentFn({ in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position }, out: d.vec4f })(fn as any);
}

export function createUnlitMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    const fn = function(input: FragInput) {
        const m = matLayout.$.material;
        const uv = d.vec2f(input.vUV.x * m.uvScaleU + m.uvOffsetU, input.vUV.y * m.uvScaleV + m.uvOffsetV);
        const tex = std.textureSample(matLayout.$.map, matLayout.$.mapSampler, uv);
        const alpha = std.mul(tex.w, m.opacity);
        if (alpha < m.alphaTest) { std.discard(); }
        return d.vec4f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
            alpha,
        );
    };
    attachShaderMetadata(fn as any, () => ({ d, std, matLayout }), false, { d, std, matLayout });
    return tgpu.fragmentFn({ in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f }, out: d.vec4f })(fn as any);
}

export function createEmissiveMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    const fn = function(input: FragInput) {
        const m = matLayout.$.material;
        const uv = d.vec2f(input.vUV.x * m.uvScaleU + m.uvOffsetU, input.vUV.y * m.uvScaleV + m.uvOffsetV);
        const tex = std.textureSample(matLayout.$.map, matLayout.$.mapSampler, uv);
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
    };
    attachShaderMetadata(fn as any, () => ({ d, std, matLayout }), false, { d, std, matLayout });
    return tgpu.fragmentFn({ in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f }, out: d.vec4f })(fn as any);
}

/**
 * 3D value noise sampled from the shared noise texture (Hoskins trick: fold z
 * into a 2D lookup). Exposed to material shaders as the free variable `noise`.
 * Call it as `noise(d.vec3f(x, y, z))`.
 */
export function createNoiseFn(_matLayout?: any) {
    const noiseFn = function noise(x: d.v3f) {
        'use gpu';
        const px = std.floor(x.x), py = std.floor(x.y), pz = std.floor(x.z);
        const fx = std.fract(x.x), fy = std.fract(x.y), fz = std.fract(x.z);
        const sx = fx * fx * (3.0 - 2.0 * fx);
        const sy = fy * fy * (3.0 - 2.0 * fy);
        const sz = fz * fz * (3.0 - 2.0 * fz);
        const ax0 = std.fract(px * 0.1031), ax1 = std.fract(ax0 + 0.1031);
        const ay0 = std.fract(py * 0.1031), ay1 = std.fract(ay0 + 0.1031);
        const az0 = std.fract(pz * 0.1031), az1 = std.fract(az0 + 0.1031);
        const d000 = ax0 * (ay0 + 33.33) + ay0 * (az0 + 33.33) + az0 * (ax0 + 33.33);
        const h000 = std.fract((ax0 + ay0 + 2.0 * d000) * (az0 + d000));
        const d100 = ax1 * (ay0 + 33.33) + ay0 * (az0 + 33.33) + az0 * (ax1 + 33.33);
        const h100 = std.fract((ax1 + ay0 + 2.0 * d100) * (az0 + d100));
        const d010 = ax0 * (ay1 + 33.33) + ay1 * (az0 + 33.33) + az0 * (ax0 + 33.33);
        const h010 = std.fract((ax0 + ay1 + 2.0 * d010) * (az0 + d010));
        const d110 = ax1 * (ay1 + 33.33) + ay1 * (az0 + 33.33) + az0 * (ax1 + 33.33);
        const h110 = std.fract((ax1 + ay1 + 2.0 * d110) * (az0 + d110));
        const d001 = ax0 * (ay0 + 33.33) + ay0 * (az1 + 33.33) + az1 * (ax0 + 33.33);
        const h001 = std.fract((ax0 + ay0 + 2.0 * d001) * (az1 + d001));
        const d101 = ax1 * (ay0 + 33.33) + ay0 * (az1 + 33.33) + az1 * (ax1 + 33.33);
        const h101 = std.fract((ax1 + ay0 + 2.0 * d101) * (az1 + d101));
        const d011 = ax0 * (ay1 + 33.33) + ay1 * (az1 + 33.33) + az1 * (ax0 + 33.33);
        const h011 = std.fract((ax0 + ay1 + 2.0 * d011) * (az1 + d011));
        const d111 = ax1 * (ay1 + 33.33) + ay1 * (az1 + 33.33) + az1 * (ax1 + 33.33);
        const h111 = std.fract((ax1 + ay1 + 2.0 * d111) * (az1 + d111));
        const x00 = std.mix(h000, h100, sx);
        const x10 = std.mix(h010, h110, sx);
        const x01 = std.mix(h001, h101, sx);
        const x11 = std.mix(h011, h111, sx);
        const y0 = std.mix(x00, x10, sy);
        const y1 = std.mix(x01, x11, sy);
        return std.mix(y0, y1, sz);
    };
    attachShaderMetadata(
        noiseFn as any,
        () => ({ d, std }),
        false,
        { d, std },
        undefined,
        `function noise(x) {
    const px = std.floor(x.x), py = std.floor(x.y), pz = std.floor(x.z);
    const fx = std.fract(x.x), fy = std.fract(x.y), fz = std.fract(x.z);
    const sx = fx * fx * (3.0 - 2.0 * fx);
    const sy = fy * fy * (3.0 - 2.0 * fy);
    const sz = fz * fz * (3.0 - 2.0 * fz);
    const ax0 = std.fract(px * 0.1031), ax1 = std.fract(ax0 + 0.1031);
    const ay0 = std.fract(py * 0.1031), ay1 = std.fract(ay0 + 0.1031);
    const az0 = std.fract(pz * 0.1031), az1 = std.fract(az0 + 0.1031);
    const d000 = ax0 * (ay0 + 33.33) + ay0 * (az0 + 33.33) + az0 * (ax0 + 33.33);
    const h000 = std.fract((ax0 + ay0 + 2.0 * d000) * (az0 + d000));
    const d100 = ax1 * (ay0 + 33.33) + ay0 * (az0 + 33.33) + az0 * (ax1 + 33.33);
    const h100 = std.fract((ax1 + ay0 + 2.0 * d100) * (az0 + d100));
    const d010 = ax0 * (ay1 + 33.33) + ay1 * (az0 + 33.33) + az0 * (ax0 + 33.33);
    const h010 = std.fract((ax0 + ay1 + 2.0 * d010) * (az0 + d010));
    const d110 = ax1 * (ay1 + 33.33) + ay1 * (az0 + 33.33) + az0 * (ax1 + 33.33);
    const h110 = std.fract((ax1 + ay1 + 2.0 * d110) * (az0 + d110));
    const d001 = ax0 * (ay0 + 33.33) + ay0 * (az1 + 33.33) + az1 * (ax0 + 33.33);
    const h001 = std.fract((ax0 + ay0 + 2.0 * d001) * (az1 + d001));
    const d101 = ax1 * (ay0 + 33.33) + ay0 * (az1 + 33.33) + az1 * (ax1 + 33.33);
    const h101 = std.fract((ax1 + ay0 + 2.0 * d101) * (az1 + d101));
    const d011 = ax0 * (ay1 + 33.33) + ay1 * (az1 + 33.33) + az1 * (ax0 + 33.33);
    const h011 = std.fract((ax0 + ay1 + 2.0 * d011) * (az1 + d011));
    const d111 = ax1 * (ay1 + 33.33) + ay1 * (az1 + 33.33) + az1 * (ax1 + 33.33);
    const h111 = std.fract((ax1 + ay1 + 2.0 * d111) * (az1 + d111));
    const x00 = std.mix(h000, h100, sx);
    const x10 = std.mix(h010, h110, sx);
    const x01 = std.mix(h001, h101, sx);
    const x11 = std.mix(h011, h111, sx);
    const y0 = std.mix(x00, x10, sy);
    const y1 = std.mix(x01, x11, sy);
    return std.mix(y0, y1, sz);
}`,
    );
    return tgpu.fn([d.vec3f], d.f32)(noiseFn as any);
}

/**
 * Signed value noise in the style of trisomie21's fireball shader. Exposed to
 * material shaders as the free variable `snoise`. Call it as
 * `snoise(d.vec3f(x, y, z), d.f32(res))`; it returns a value in [-1, 1].
 */
export function createSnoiseFn(_matLayout?: any) {
    const snoiseFn = function snoise(uv: d.v3f, res: number) {
        'use gpu';
        const s = d.vec3f(1.0, 100.0, 10000.0);
        const invRes = 1.0 / res;
        const r3 = d.vec3f(res, res, res);
        const u = std.mul(uv, res);
        const uv0 = std.mul(std.floor(std.sub(u, std.mul(std.floor(std.mul(u, invRes)), r3))), s);
        const u1 = std.add(u, d.vec3f(1.0, 1.0, 1.0));
        const uv1 = std.mul(std.floor(std.sub(u1, std.mul(std.floor(std.mul(u1, invRes)), r3))), s);
        const fr = std.fract(u);
        const ff = std.mul(std.mul(fr, fr), std.sub(d.vec3f(3.0, 3.0, 3.0), std.mul(d.vec3f(2.0, 2.0, 2.0), fr)));
        const v = d.vec4f(uv0.x + uv0.y + uv0.z, uv1.x + uv0.y + uv0.z, uv0.x + uv1.y + uv0.z, uv1.x + uv1.y + uv0.z);
        const ra = std.fract(std.mul(std.sin(std.mul(v, 1e-3)), 1e5));
        const r0 = std.mix(std.mix(ra.x, ra.y, ff.x), std.mix(ra.z, ra.w, ff.x), ff.y);
        const dz = uv1.z - uv0.z;
        const v2 = std.add(v, d.vec4f(dz, dz, dz, dz));
        const rb = std.fract(std.mul(std.sin(std.mul(v2, 1e-3)), 1e5));
        const r1 = std.mix(std.mix(rb.x, rb.y, ff.x), std.mix(rb.z, rb.w, ff.x), ff.y);
        return std.mix(r0, r1, ff.z) * 2.0 - 1.0;
    };
    attachShaderMetadata(
        snoiseFn as any,
        () => ({ d, std }),
        false,
        { d, std },
        undefined,
        `function snoise(uv, res) {
    const s = d.vec3f(1.0, 100.0, 10000.0);
    const invRes = 1.0 / res;
    const r3 = d.vec3f(res, res, res);
    const u = std.mul(uv, res);
    const uv0 = std.mul(std.floor(std.sub(u, std.mul(std.floor(std.mul(u, invRes)), r3))), s);
    const u1 = std.add(u, d.vec3f(1.0, 1.0, 1.0));
    const uv1 = std.mul(std.floor(std.sub(u1, std.mul(std.floor(std.mul(u1, invRes)), r3))), s);
    const fr = std.fract(u);
    const ff = std.mul(std.mul(fr, fr), std.sub(d.vec3f(3.0, 3.0, 3.0), std.mul(d.vec3f(2.0, 2.0, 2.0), fr)));
    const v = d.vec4f(uv0.x + uv0.y + uv0.z, uv1.x + uv0.y + uv0.z, uv0.x + uv1.y + uv0.z, uv1.x + uv1.y + uv0.z);
    const ra = std.fract(std.mul(std.sin(std.mul(v, 1e-3)), 1e5));
    const r0 = std.mix(std.mix(ra.x, ra.y, ff.x), std.mix(ra.z, ra.w, ff.x), ff.y);
    const dz = uv1.z - uv0.z;
    const v2 = std.add(v, d.vec4f(dz, dz, dz, dz));
    const rb = std.fract(std.mul(std.sin(std.mul(v2, 1e-3)), 1e5));
    const r1 = std.mix(std.mix(rb.x, rb.y, ff.x), std.mix(rb.z, rb.w, ff.x), ff.y);
    return std.mix(r0, r1, ff.z) * 2.0 - 1.0;
}`,
    );
    return tgpu.fn([d.vec3f, d.f32], d.f32)(snoiseFn as any);
}

export { createTexturedMeshVertex };

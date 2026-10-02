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
    _pad0: d.f32,
    _pad1: d.f32,
    _pad2: d.f32,
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
};

export function createStandardMaterialFragment(meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    const fn = function(input: FragInput) {
        const u = meshLayout.$.uniforms;
        const m = matLayout.$.material;
        const tex = std.textureSample(matLayout.$.map, matLayout.$.mapSampler, d.vec2f(input.vUV.x, input.vUV.y));
        const baseColor = d.vec3f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
        );
        const worldPos = d.vec3f(input.vWorldPos.x, input.vWorldPos.y, input.vWorldPos.z);
        const normal = std.normalize(d.vec3f(input.vNormal.x, input.vNormal.y, input.vNormal.z));

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

        const mapped = tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, std.mul(tex.w, m.opacity));
    };
    attachShaderMetadata(fn as any, () => ({ d, std, meshLayout, matLayout, lightContribution, tonemap }), false, { d, std, meshLayout, matLayout });
    return tgpu.fragmentFn({ in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f }, out: d.vec4f })(fn as any);
}

export function createUnlitMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    const fn = function(input: FragInput) {
        const m = matLayout.$.material;
        const tex = std.textureSample(matLayout.$.map, matLayout.$.mapSampler, d.vec2f(input.vUV.x, input.vUV.y));
        return d.vec4f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
            std.mul(tex.w, m.opacity),
        );
    };
    attachShaderMetadata(fn as any, () => ({ d, std, matLayout }), false, { d, std, matLayout });
    return tgpu.fragmentFn({ in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f }, out: d.vec4f })(fn as any);
}

export function createEmissiveMaterialFragment(_meshLayout: MeshDataLayout, matLayout: EngineMaterialLayout) {
    const fn = function(input: FragInput) {
        const m = matLayout.$.material;
        const tex = std.textureSample(matLayout.$.map, matLayout.$.mapSampler, d.vec2f(input.vUV.x, input.vUV.y));
        const baseColor = d.vec3f(
            std.mul(std.mul(tex.x, input.vColor.x), m.colorR),
            std.mul(std.mul(tex.y, input.vColor.y), m.colorG),
            std.mul(std.mul(tex.z, input.vColor.z), m.colorB),
        );
        return d.vec4f(
            std.mul(baseColor.x, m.emissive),
            std.mul(baseColor.y, m.emissive),
            std.mul(baseColor.z, m.emissive),
            std.mul(tex.w, m.opacity),
        );
    };
    attachShaderMetadata(fn as any, () => ({ d, std, matLayout }), false, { d, std, matLayout });
    return tgpu.fragmentFn({ in: { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f }, out: d.vec4f })(fn as any);
}

export { createTexturedMeshVertex };

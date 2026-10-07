import { tgpu, d, std } from '../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import { DynamicMesh, SkinnedStaticMesh } from '../../../core/types';
import type { TgpuVertexFn, TgpuFragmentFn } from 'typegpu';

/**
 * Skinned layout for a light shadow pass: the same per-light uniform the
 * non-skinned pass uses, plus the skinning buffers. The pass struct is the
 * caller's (spot/point) so both passes can bind the same buffer layout.
 */
export function createSkinnedLightLayout(passUniform: unknown, maxInstances: number, maxBones: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: passUniform as never },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(SkinnedStaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
        boneMatrices: { storage: d.arrayOf(d.mat4x4f, maxBones) },
    });
}

/** Skinned caster vertex: skin, then instance TRS, outputting world position. */
export function createSkinnedLightVertex(layout: ReturnType<typeof createSkinnedLightLayout>): TgpuVertexFn {
    const _WS = ['d', 'std', 'layout', 'mix', 'cos', 'sin', 'mul', 'mat4x4f'];
    const fn = function(input: {
        position: { x: number; y: number; z: number };
        normal: { x: number; y: number; z: number };
        uv: { x: number; y: number };
        joints: { x: number; y: number; z: number; w: number };
        weights: { x: number; y: number; z: number; w: number };
        instanceIndex: number;
    }) {
        const slot = layout.$.slotIndices[input.instanceIndex];
        const dyn = layout.$.dynamicInstances[slot];
        const stat = layout.$.staticInstances[slot];
        const boneOffset = stat.boneOffset;
        const j0 = input.joints.x, j1 = input.joints.y, j2 = input.joints.z, j3 = input.joints.w;
        const w0 = input.weights.x, w1 = input.weights.y, w2 = input.weights.z, w3 = input.weights.w;
        const bm = layout.$.boneMatrices;
        const m0 = bm[(d.i32(boneOffset) + d.i32(j0))];
        const m1 = bm[(d.i32(boneOffset) + d.i32(j1))];
        const m2 = bm[(d.i32(boneOffset) + d.i32(j2))];
        const m3 = bm[(d.i32(boneOffset) + d.i32(j3))];
        const p = d.vec4f(input.position.x, input.position.y, input.position.z, 1.0);
        // @ts-ignore — TGSL matrix * vector
        const sp0 = m0 * p as unknown as d.v4f;
        // @ts-ignore
        const sp1 = m1 * p as unknown as d.v4f;
        // @ts-ignore
        const sp2 = m2 * p as unknown as d.v4f;
        // @ts-ignore
        const sp3 = m3 * p as unknown as d.v4f;
        const skinned = d.vec3f(
            sp0.x * w0 + sp1.x * w1 + sp2.x * w2 + sp3.x * w3,
            sp0.y * w0 + sp1.y * w1 + sp2.y * w2 + sp3.y * w3,
            sp0.z * w0 + sp1.z * w1 + sp2.z * w2 + sp3.z * w3,
        );
        const scaled = d.vec3f(skinned.x * stat.scaleX, skinned.y * stat.scaleY, skinned.z * stat.scaleZ);
        const czr = std.cos(dyn.currRotZ), szr = std.sin(dyn.currRotZ);
        const rz1 = d.vec3f(
            std.sub(std.mul(scaled.x, czr), std.mul(scaled.y, szr)),
            std.add(std.mul(scaled.x, szr), std.mul(scaled.y, czr)),
            scaled.z,
        );
        const cyr = std.cos(dyn.currRotY), syr = std.sin(dyn.currRotY);
        const ry1 = d.vec3f(
            std.add(std.mul(rz1.x, cyr), std.mul(rz1.z, syr)),
            rz1.y,
            std.sub(std.mul(rz1.z, cyr), std.mul(rz1.x, syr)),
        );
        const cxr = std.cos(dyn.currRotX), sxr = std.sin(dyn.currRotX);
        const rx1 = d.vec3f(
            ry1.x,
            std.sub(std.mul(ry1.y, cxr), std.mul(ry1.z, sxr)),
            std.add(std.mul(ry1.y, sxr), std.mul(ry1.z, cxr)),
        );
        const world = d.vec4f(std.add(rx1.x, dyn.currPosX), std.add(rx1.y, dyn.currPosY), std.add(rx1.z, dyn.currPosZ), 1.0);
        const clip = std.mul((layout.$.uniforms as any).viewProjection, world);
        return { pos: clip, vWorld: d.vec3f(world.x, world.y, world.z) };
    };
    attachShaderMetadata(fn as any, () => ({ d, std, layout }), false, { d, std, layout }, _WS);
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            uv: d.location(2, d.vec2f),
            joints: d.location(3, d.vec4u),
            weights: d.location(4, d.vec4f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: { pos: d.builtin.position, vWorld: d.vec3f },
    } as any)(fn as any);
}

/** Fragment that stores linear distance / far from the light. */
export function createLightDistanceFragment(layout: { $: { uniforms: { lightPosFar: { x: number; y: number; z: number; w: number } } } }): TgpuFragmentFn {
    const fn = function(input: { vWorld: { x: number; y: number; z: number } }) {
        const lp = layout.$.uniforms.lightPosFar;
        const dist = std.length(d.vec3f(input.vWorld.x - lp.x, input.vWorld.y - lp.y, input.vWorld.z - lp.z)) / lp.w;
        return d.vec4f(dist, dist, dist, 1.0);
    };
    attachShaderMetadata(fn as any, () => ({ d, std, layout }), false, { d, std, layout });
    return tgpu.fragmentFn({ in: { vWorld: d.vec3f }, out: d.vec4f } as any)(fn as any);
}

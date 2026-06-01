/**
 * TypeGPU TGSL 3D mesh shader.
 *
 * Vertex attributes from vertex buffer (position + normal).
 * Instance data from storage buffers (TRS + color) via index buffer indirection.
 * Basic diffuse lighting.
 */
import tgpu from 'typegpu';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';
import { DynamicMesh, StaticMesh, SkinnedStaticMesh, MeshUniforms, Light } from '../core/types';
import { lightContribution, tonemap } from '../shaders/utils';

/** Max point/spot lights the mesh shaders' storage buffer holds. */
export const MAX_LIGHTS = 64;

export function createMeshLayout(maxInstances: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: MeshUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(StaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
        lights: { storage: d.arrayOf(Light, MAX_LIGHTS) },
    });
}

export type MeshDataLayout = ReturnType<typeof createMeshLayout>;

export function createMeshVertex(meshLayout: MeshDataLayout) {
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: {
            pos: d.builtin.position,
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vWorldPos: d.vec3f,
        },
    })(function(input) {
        const instanceIndex = input.instanceIndex;
        const slot = meshLayout.$.slotIndices[instanceIndex];
        const dyn = meshLayout.$.dynamicInstances[slot];
        const stat = meshLayout.$.staticInstances[slot];
        const alpha = meshLayout.$.uniforms.alpha;

        // Interpolate position
        const px = std.mix(dyn.prevPosX, dyn.currPosX, alpha);
        const py = std.mix(dyn.prevPosY, dyn.currPosY, alpha);
        const pz = std.mix(dyn.prevPosZ, dyn.currPosZ, alpha);

        // Interpolate rotation (euler angles)
        const rx = std.mix(dyn.prevRotX, dyn.currRotX, alpha);
        const ry = std.mix(dyn.prevRotY, dyn.currRotY, alpha);
        const rz = std.mix(dyn.prevRotZ, dyn.currRotZ, alpha);

        // Scale
        const sx = stat.scaleX;
        const sy = stat.scaleY;
        const sz = stat.scaleZ;

        // Build TRS inline: scale → rotateZ → rotateY → rotateX → translate
        // Scale the vertex
        const scaled = d.vec3f(
            std.mul(input.position.x, sx),
            std.mul(input.position.y, sy),
            std.mul(input.position.z, sz),
        );

        // Rotate Z
        const czr = std.cos(rz);
        const szr = std.sin(rz);
        const rz1 = d.vec3f(
            std.sub(std.mul(scaled.x, czr), std.mul(scaled.y, szr)),
            std.add(std.mul(scaled.x, szr), std.mul(scaled.y, czr)),
            scaled.z,
        );

        // Rotate Y
        const cyr = std.cos(ry);
        const syr = std.sin(ry);
        const ry1 = d.vec3f(
            std.add(std.mul(rz1.x, cyr), std.mul(rz1.z, syr)),
            rz1.y,
            std.sub(std.mul(rz1.z, cyr), std.mul(rz1.x, syr)),
        );

        // Rotate X
        const cxr = std.cos(rx);
        const sxr = std.sin(rx);
        const rx1 = d.vec3f(
            ry1.x,
            std.sub(std.mul(ry1.y, cxr), std.mul(ry1.z, sxr)),
            std.add(std.mul(ry1.y, sxr), std.mul(ry1.z, cxr)),
        );

        // Translate
        const worldPos = d.vec4f(
            std.add(rx1.x, px),
            std.add(rx1.y, py),
            std.add(rx1.z, pz),
            1.0,
        );

        // Transform normal (rotation only, no scale to keep unit length)
        const nScaled = input.normal;
        const nRz = d.vec3f(
            std.sub(std.mul(nScaled.x, czr), std.mul(nScaled.y, szr)),
            std.add(std.mul(nScaled.x, szr), std.mul(nScaled.y, czr)),
            nScaled.z,
        );
        const nRy = d.vec3f(
            std.add(std.mul(nRz.x, cyr), std.mul(nRz.z, syr)),
            nRz.y,
            std.sub(std.mul(nRz.z, cyr), std.mul(nRz.x, syr)),
        );
        const nRx = d.vec3f(
            nRy.x,
            std.sub(std.mul(nRy.y, cxr), std.mul(nRy.z, sxr)),
            std.add(std.mul(nRy.y, sxr), std.mul(nRy.z, cxr)),
        );

        const clipPos = std.mul(meshLayout.$.uniforms.viewProjection, worldPos);

        return {
            pos: clipPos,
            vNormal: nRx,
            vColor: d.vec3f(stat.colorR, stat.colorG, stat.colorB),
            vWorldPos: d.vec3f(worldPos.x, worldPos.y, worldPos.z),
        };
    });
}

export function createMeshFragment(meshLayout: MeshDataLayout | SkinnedMeshDataLayout) {
    return tgpu.fragmentFn({
        in: {
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vWorldPos: d.vec3f,
        },
        out: d.vec4f,
    })(function(input) {
        const u = meshLayout.$.uniforms;
        const baseColor = input.vColor;
        const worldPos = input.vWorldPos;
        const normal = std.normalize(input.vNormal);

        // Fixed directional light (the engine's classic look) + ambient.
        const lightDir = std.normalize(d.vec3f(u.lightDirX, u.lightDirY, u.lightDirZ));
        const diff = std.max(std.dot(normal, lightDir), 0.0) * u.lightDirIntensity;

        let acc = d.vec3f(
            baseColor.x * (u.ambientR + u.lightDirR * diff),
            baseColor.y * (u.ambientG + u.lightDirG * diff),
            baseColor.z * (u.ambientB + u.lightDirB * diff),
        );

        // Dynamic point/spot lights — interpolate pos/dir by alpha, then the
        // shared lightContribution fn does the per-light shading math.
        const count = u.lightCount;
        const a = u.alpha;
        for (let i = d.u32(0); i < count; i++) {
            const L = meshLayout.$.lights[i];
            const pos = d.vec3f(
                std.mix(L.prevPosX, L.currPosX, a),
                std.mix(L.prevPosY, L.currPosY, a),
                std.mix(L.prevPosZ, L.currPosZ, a),
            );
            const axis = d.vec3f(
                std.mix(L.prevDirX, L.currDirX, a),
                std.mix(L.prevDirY, L.currDirY, a),
                std.mix(L.prevDirZ, L.currDirZ, a),
            );
            const c = lightContribution(
                pos,
                axis,
                d.vec3f(L.colorR, L.colorG, L.colorB),
                d.vec4f(L.intensity, L.range, L.innerCos, L.outerCos),
                normal,
                worldPos,
            );
            acc = d.vec3f(
                acc.x + baseColor.x * c.x,
                acc.y + baseColor.y * c.y,
                acc.z + baseColor.z * c.z,
            );
        }

        const mapped = tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, 1.0);
    });
}

// --- Textured pipeline: adds UV attribute + texture sampling ---

export function createTextureBindGroupLayout() {
    return tgpu.bindGroupLayout({
        modelTexture: { texture: 'float' },
        modelSampler: { sampler: 'filtering' },
    });
}

export type TextureBindGroupLayout = ReturnType<typeof createTextureBindGroupLayout>;

export function createTexturedMeshVertex(meshLayout: MeshDataLayout) {
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            uv: d.location(2, d.vec2f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: {
            pos: d.builtin.position,
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vUV: d.vec2f,
            vWorldPos: d.vec3f,
        },
    })(function(input) {
        const instanceIndex = input.instanceIndex;
        const slot = meshLayout.$.slotIndices[instanceIndex];
        const dyn = meshLayout.$.dynamicInstances[slot];
        const stat = meshLayout.$.staticInstances[slot];
        const alpha = meshLayout.$.uniforms.alpha;

        // Interpolate position
        const px = std.mix(dyn.prevPosX, dyn.currPosX, alpha);
        const py = std.mix(dyn.prevPosY, dyn.currPosY, alpha);
        const pz = std.mix(dyn.prevPosZ, dyn.currPosZ, alpha);

        // Interpolate rotation (euler angles)
        const rx = std.mix(dyn.prevRotX, dyn.currRotX, alpha);
        const ry = std.mix(dyn.prevRotY, dyn.currRotY, alpha);
        const rz = std.mix(dyn.prevRotZ, dyn.currRotZ, alpha);

        // Scale
        const sx = stat.scaleX;
        const sy = stat.scaleY;
        const sz = stat.scaleZ;

        // Build TRS inline: scale → rotateZ → rotateY → rotateX → translate
        const scaled = d.vec3f(
            std.mul(input.position.x, sx),
            std.mul(input.position.y, sy),
            std.mul(input.position.z, sz),
        );

        // Rotate Z
        const czr = std.cos(rz);
        const szr = std.sin(rz);
        const rz1 = d.vec3f(
            std.sub(std.mul(scaled.x, czr), std.mul(scaled.y, szr)),
            std.add(std.mul(scaled.x, szr), std.mul(scaled.y, czr)),
            scaled.z,
        );

        // Rotate Y
        const cyr = std.cos(ry);
        const syr = std.sin(ry);
        const ry1 = d.vec3f(
            std.add(std.mul(rz1.x, cyr), std.mul(rz1.z, syr)),
            rz1.y,
            std.sub(std.mul(rz1.z, cyr), std.mul(rz1.x, syr)),
        );

        // Rotate X
        const cxr = std.cos(rx);
        const sxr = std.sin(rx);
        const rx1 = d.vec3f(
            ry1.x,
            std.sub(std.mul(ry1.y, cxr), std.mul(ry1.z, sxr)),
            std.add(std.mul(ry1.y, sxr), std.mul(ry1.z, cxr)),
        );

        // Translate
        const worldPos = d.vec4f(
            std.add(rx1.x, px),
            std.add(rx1.y, py),
            std.add(rx1.z, pz),
            1.0,
        );

        // Transform normal (rotation only)
        const nScaled = input.normal;
        const nRz = d.vec3f(
            std.sub(std.mul(nScaled.x, czr), std.mul(nScaled.y, szr)),
            std.add(std.mul(nScaled.x, szr), std.mul(nScaled.y, czr)),
            nScaled.z,
        );
        const nRy = d.vec3f(
            std.add(std.mul(nRz.x, cyr), std.mul(nRz.z, syr)),
            nRz.y,
            std.sub(std.mul(nRz.z, cyr), std.mul(nRz.x, syr)),
        );
        const nRx = d.vec3f(
            nRy.x,
            std.sub(std.mul(nRy.y, cxr), std.mul(nRy.z, sxr)),
            std.add(std.mul(nRy.y, sxr), std.mul(nRy.z, cxr)),
        );

        const clipPos = std.mul(meshLayout.$.uniforms.viewProjection, worldPos);

        return {
            pos: clipPos,
            vNormal: nRx,
            vColor: d.vec3f(stat.colorR, stat.colorG, stat.colorB),
            vUV: input.uv,
            vWorldPos: d.vec3f(worldPos.x, worldPos.y, worldPos.z),
        };
    });
}

export function createTexturedMeshFragment(meshLayout: MeshDataLayout | SkinnedMeshDataLayout, texLayout: TextureBindGroupLayout) {
    return tgpu.fragmentFn({
        in: {
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vUV: d.vec2f,
            vWorldPos: d.vec3f,
        },
        out: d.vec4f,
    })(function(input) {
        const u = meshLayout.$.uniforms;
        const worldPos = input.vWorldPos;
        const normal = std.normalize(input.vNormal);

        // Sample texture, multiply by instance color (tint)
        const texColor = std.textureSample(texLayout.$.modelTexture, texLayout.$.modelSampler, input.vUV);
        const baseColor = d.vec3f(
            std.mul(texColor.x, input.vColor.x),
            std.mul(texColor.y, input.vColor.y),
            std.mul(texColor.z, input.vColor.z),
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
            const pos = d.vec3f(
                std.mix(L.prevPosX, L.currPosX, a),
                std.mix(L.prevPosY, L.currPosY, a),
                std.mix(L.prevPosZ, L.currPosZ, a),
            );
            const axis = d.vec3f(
                std.mix(L.prevDirX, L.currDirX, a),
                std.mix(L.prevDirY, L.currDirY, a),
                std.mix(L.prevDirZ, L.currDirZ, a),
            );
            const c = lightContribution(
                pos,
                axis,
                d.vec3f(L.colorR, L.colorG, L.colorB),
                d.vec4f(L.intensity, L.range, L.innerCos, L.outerCos),
                normal,
                worldPos,
            );
            acc = d.vec3f(
                acc.x + baseColor.x * c.x,
                acc.y + baseColor.y * c.y,
                acc.z + baseColor.z * c.z,
            );
        }

        const mapped = tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, texColor.w);
    });
}

// =============================================================================
// Skinned mesh shaders
// =============================================================================

export function createSkinnedMeshLayout(maxInstances: number, maxBones: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: MeshUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(SkinnedStaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
        boneMatrices: { storage: d.arrayOf(d.mat4x4f, maxBones) },
        lights: { storage: d.arrayOf(Light, MAX_LIGHTS) },
    });
}

export type SkinnedMeshDataLayout = ReturnType<typeof createSkinnedMeshLayout>;

export function createSkinnedMeshVertex(layout: SkinnedMeshDataLayout) {
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            uv: d.location(2, d.vec2f),
            joints: d.location(3, d.vec4u),
            weights: d.location(4, d.vec4f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: {
            pos: d.builtin.position,
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vUV: d.vec2f,
            vWorldPos: d.vec3f,
        },
    })(function(input) {
        const slot = layout.$.slotIndices[input.instanceIndex];
        const dyn = layout.$.dynamicInstances[slot];
        const stat = layout.$.staticInstances[slot];
        const alpha = layout.$.uniforms.alpha;
        const boneOffset = stat.boneOffset;

        // --- Skinning: blend 4 bone matrices ---
        const j0 = input.joints.x;
        const j1 = input.joints.y;
        const j2 = input.joints.z;
        const j3 = input.joints.w;
        const w0 = input.weights.x;
        const w1 = input.weights.y;
        const w2 = input.weights.z;
        const w3 = input.weights.w;

        const m0 = layout.$.boneMatrices[boneOffset + j0];
        const m1 = layout.$.boneMatrices[boneOffset + j1];
        const m2 = layout.$.boneMatrices[boneOffset + j2];
        const m3 = layout.$.boneMatrices[boneOffset + j3];

        // Blend: skinMatrix = w0*m0 + w1*m1 + w2*m2 + w3*m3
        // Apply to position
        const p = d.vec4f(input.position.x, input.position.y, input.position.z, 1.0);
        // @ts-ignore — TGSL: matrix * vector arithmetic
        const sp0 = m0 * p as unknown as d.v4f;
        // @ts-ignore
        const sp1 = m1 * p as unknown as d.v4f;
        // @ts-ignore
        const sp2 = m2 * p as unknown as d.v4f;
        // @ts-ignore
        const sp3 = m3 * p as unknown as d.v4f;

        const skinnedPos = d.vec3f(
            sp0.x * w0 + sp1.x * w1 + sp2.x * w2 + sp3.x * w3,
            sp0.y * w0 + sp1.y * w1 + sp2.y * w2 + sp3.y * w3,
            sp0.z * w0 + sp1.z * w1 + sp2.z * w2 + sp3.z * w3,
        );

        // Apply to normal (mat3 upper-left, no translation)
        const n = d.vec4f(input.normal.x, input.normal.y, input.normal.z, 0.0);
        // @ts-ignore
        const sn0 = m0 * n as unknown as d.v4f;
        // @ts-ignore
        const sn1 = m1 * n as unknown as d.v4f;
        // @ts-ignore
        const sn2 = m2 * n as unknown as d.v4f;
        // @ts-ignore
        const sn3 = m3 * n as unknown as d.v4f;

        const skinnedNormal = d.vec3f(
            sn0.x * w0 + sn1.x * w1 + sn2.x * w2 + sn3.x * w3,
            sn0.y * w0 + sn1.y * w1 + sn2.y * w2 + sn3.y * w3,
            sn0.z * w0 + sn1.z * w1 + sn2.z * w2 + sn3.z * w3,
        );

        // --- Instance TRS transform (same as non-skinned) ---
        const px = std.mix(dyn.prevPosX, dyn.currPosX, alpha);
        const py = std.mix(dyn.prevPosY, dyn.currPosY, alpha);
        const pz = std.mix(dyn.prevPosZ, dyn.currPosZ, alpha);

        const rx = std.mix(dyn.prevRotX, dyn.currRotX, alpha);
        const ry = std.mix(dyn.prevRotY, dyn.currRotY, alpha);
        const rz = std.mix(dyn.prevRotZ, dyn.currRotZ, alpha);

        const sx = stat.scaleX;
        const sy = stat.scaleY;
        const sz = stat.scaleZ;

        // Scale
        const scaled = d.vec3f(skinnedPos.x * sx, skinnedPos.y * sy, skinnedPos.z * sz);

        // Rotate Z
        const czr = std.cos(rz);
        const szr = std.sin(rz);
        const rz1 = d.vec3f(
            scaled.x * czr - scaled.y * szr,
            scaled.x * szr + scaled.y * czr,
            scaled.z,
        );

        // Rotate Y
        const cyr = std.cos(ry);
        const syr = std.sin(ry);
        const ry1 = d.vec3f(
            rz1.x * cyr + rz1.z * syr,
            rz1.y,
            rz1.z * cyr - rz1.x * syr,
        );

        // Rotate X
        const cxr = std.cos(rx);
        const sxr = std.sin(rx);
        const rx1 = d.vec3f(
            ry1.x,
            ry1.y * cxr - ry1.z * sxr,
            ry1.y * sxr + ry1.z * cxr,
        );

        // Translate
        const worldPos = d.vec4f(rx1.x + px, rx1.y + py, rx1.z + pz, 1.0);

        // Rotate normal (same rotations, no scale/translate)
        const nRz = d.vec3f(
            skinnedNormal.x * czr - skinnedNormal.y * szr,
            skinnedNormal.x * szr + skinnedNormal.y * czr,
            skinnedNormal.z,
        );
        const nRy = d.vec3f(
            nRz.x * cyr + nRz.z * syr,
            nRz.y,
            nRz.z * cyr - nRz.x * syr,
        );
        const nRx = d.vec3f(
            nRy.x,
            nRy.y * cxr - nRy.z * sxr,
            nRy.y * sxr + nRy.z * cxr,
        );

        // @ts-ignore — TGSL: matrix * vector
        const clipPos = layout.$.uniforms.viewProjection * worldPos as unknown as d.v4f;

        return {
            pos: clipPos,
            vNormal: nRx,
            vColor: d.vec3f(stat.colorR, stat.colorG, stat.colorB),
            vUV: input.uv,
            vWorldPos: d.vec3f(worldPos.x, worldPos.y, worldPos.z),
        };
    });
}

/**
 * Fragment shader for untextured skinned meshes. The skinned vertex shader
 * always emits `vUV` (location 2) because it is shared with the textured path,
 * so this fragment must declare `vUV` in its `in` too, otherwise `vWorldPos`
 * lands on location 2 and collides with the vertex's `vUV` (vec2 vs vec3). The
 * UV is simply unused here. Lighting matches createMeshFragment.
 */
export function createSkinnedMeshFragment(meshLayout: SkinnedMeshDataLayout) {
    return tgpu.fragmentFn({
        in: {
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vUV: d.vec2f,
            vWorldPos: d.vec3f,
        },
        out: d.vec4f,
    })(function(input) {
        const u = meshLayout.$.uniforms;
        const baseColor = input.vColor;
        const worldPos = input.vWorldPos;
        const normal = std.normalize(input.vNormal);

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
            const pos = d.vec3f(
                std.mix(L.prevPosX, L.currPosX, a),
                std.mix(L.prevPosY, L.currPosY, a),
                std.mix(L.prevPosZ, L.currPosZ, a),
            );
            const axis = d.vec3f(
                std.mix(L.prevDirX, L.currDirX, a),
                std.mix(L.prevDirY, L.currDirY, a),
                std.mix(L.prevDirZ, L.currDirZ, a),
            );
            const c = lightContribution(
                pos,
                axis,
                d.vec3f(L.colorR, L.colorG, L.colorB),
                d.vec4f(L.intensity, L.range, L.innerCos, L.outerCos),
                normal,
                worldPos,
            );
            acc = d.vec3f(
                acc.x + baseColor.x * c.x,
                acc.y + baseColor.y * c.y,
                acc.z + baseColor.z * c.z,
            );
        }

        const mapped = tonemap(acc);
        return d.vec4f(mapped.x, mapped.y, mapped.z, 1.0);
    });
}

export { createTexturedMeshFragment as createSkinnedTexturedMeshFragment };

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
import { DynamicMesh, StaticMesh, MeshUniforms } from '../core/types';

export function createMeshLayout(maxInstances: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: MeshUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(StaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
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
        };
    });
}

export function createMeshFragment(meshLayout: MeshDataLayout) {
    return tgpu.fragmentFn({
        in: {
            vNormal: d.vec3f,
            vColor: d.vec3f,
        },
        out: d.vec4f,
    })(function(input) {
        const normal = std.normalize(input.vNormal);
        const lightDir = std.normalize(d.vec3f(
            meshLayout.$.uniforms.lightDirX,
            meshLayout.$.uniforms.lightDirY,
            meshLayout.$.uniforms.lightDirZ,
        ));

        const diff = std.max(std.dot(normal, lightDir), 0.0);
        const ambient = std.mul(input.vColor, 0.3);
        const diffuse = std.mul(input.vColor, diff);

        return d.vec4f(
            std.add(ambient.x, diffuse.x),
            std.add(ambient.y, diffuse.y),
            std.add(ambient.z, diffuse.z),
            1.0,
        );
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
        };
    });
}

export function createTexturedMeshFragment(meshLayout: MeshDataLayout, texLayout: TextureBindGroupLayout) {
    return tgpu.fragmentFn({
        in: {
            vNormal: d.vec3f,
            vColor: d.vec3f,
            vUV: d.vec2f,
        },
        out: d.vec4f,
    })(function(input) {
        const normal = std.normalize(input.vNormal);
        const lightDir = std.normalize(d.vec3f(
            meshLayout.$.uniforms.lightDirX,
            meshLayout.$.uniforms.lightDirY,
            meshLayout.$.uniforms.lightDirZ,
        ));

        // Sample texture, multiply by instance color (tint)
        const texColor = std.textureSample(texLayout.$.modelTexture, texLayout.$.modelSampler, input.vUV);
        const baseColor = d.vec3f(
            std.mul(texColor.x, input.vColor.x),
            std.mul(texColor.y, input.vColor.y),
            std.mul(texColor.z, input.vColor.z),
        );

        const diff = std.max(std.dot(normal, lightDir), 0.0);
        const ambient = std.mul(baseColor, 0.3);
        const diffuse = std.mul(baseColor, diff);

        return d.vec4f(
            std.add(ambient.x, diffuse.x),
            std.add(ambient.y, diffuse.y),
            std.add(ambient.z, diffuse.z),
            std.mul(texColor.w, 1.0),
        );
    });
}

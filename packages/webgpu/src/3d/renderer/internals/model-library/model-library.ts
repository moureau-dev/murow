import type { ParsedGltf, PrimitiveSkinAttributes, CubeUvMode } from 'murow/renderer';
import { SkeletalAnimation, parseGltf } from 'murow/renderer';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { GltfModel, ModelData, ModelHandle } from '../../types';
import { createTextureFromBitmap } from '../../../../spritesheet/spritesheet';
import {
    createCube as builtInCube,
    createPlane as builtInPlane,
    createGrid as builtInGrid,
    createSphere as builtInSphere,
    createCylinder as builtInCylinder,
    createCone as builtInCone,
    deinterleaveGeometry,
} from '../../../../geometry/built-in';
import type { MeshPipelines } from '../mesh-pipelines/mesh-pipelines';
import type { TextureRegistry } from '../texture-registry';
import type { SkinnedModelEntry } from '../skeletal-runtime';

/** GPU mesh record: vertex/index buffers plus cull/pick bounds and texture. */
export interface ModelEntry {
    rawVertexBuffer: GPUBuffer;
    rawIndexBuffer: GPUBuffer | null;
    vertexCount: number;
    indexCount: number;
    indexFormat: GPUIndexFormat;
    boundingRadius: number;
    halfX: number;
    halfY: number;
    halfZ: number;
    /** Model-local AABB center (bbox center, not necessarily the origin). */
    centerX: number;
    centerY: number;
    centerZ: number;
    hasTexture: boolean;
    textureBindGroup: GPUBindGroup | null;
    skinned: boolean;
    skinIndex: number;
}

type SkinData = NonNullable<ParsedGltf['skin']>['data'];
type AnimClips = NonNullable<ParsedGltf['skin']>['animClips'];

export interface ModelLibraryDeps {
    device: GPUDevice;
    pipelines: MeshPipelines;
    textures: TextureRegistry;
    /** Pack a newly loaded skin's clips into the animation runtime. */
    onSkinLoaded(skinData: SkinData, animClips: AnimClips): void;
}

/**
 * ModelLibrary — owns the GPU mesh registry: registers geometry (primitives
 * and glTF uploads), assigns model ids, and tracks skinned model entries.
 */
export class ModelLibrary {
    readonly models: ModelEntry[] = [];
    readonly skinnedModels: SkinnedModelEntry[] = [];

    private nextModelId = 0;

    constructor(private readonly deps: ModelLibraryDeps) {}

    get(id: number): ModelEntry | undefined {
        return this.models[id];
    }

    skinnedModel(index: number): SkinnedModelEntry | undefined {
        return this.skinnedModels[index];
    }

    skinnedModelCount(): number {
        return this.skinnedModels.length;
    }

    destroy(): void {
        for (const m of this.models) {
            m.rawVertexBuffer.destroy();
            m.rawIndexBuffer?.destroy();
        }
        this.models.length = 0;
    }

    createGrid(opts: { size?: number; step?: number; lineWidth?: number } = {}): ModelHandle {
        const geometry = builtInGrid({ size: opts.size, step: opts.step, lineWidth: opts.lineWidth });
        const { positions, normals, uvs } = deinterleaveGeometry(geometry);
        return this.createMesh({ positions, normals, uvs, indices: geometry.indices! });
    }

    createCube(opts: { size?: number; textureId?: string; uv?: CubeUvMode } = {}): ModelHandle {
        const geometry = builtInCube({ size: opts.size, uv: opts.uv });
        const { positions, normals, uvs } = deinterleaveGeometry(geometry);
        return this.createMesh({ positions, normals, uvs, textureId: opts.textureId });
    }

    createSphere(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        const geometry = builtInSphere(opts.segments ?? 16, opts.segments ?? 16);
        const { positions, normals, uvs } = deinterleaveGeometry(geometry);
        return this.createMesh({ positions, normals, uvs, textureId: opts.textureId });
    }

    createCylinder(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        const geometry = builtInCylinder(opts.segments ?? 32);
        const { positions, normals, uvs } = deinterleaveGeometry(geometry);
        return this.createMesh({ positions, normals, uvs, textureId: opts.textureId });
    }

    createCone(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        const geometry = builtInCone(opts.segments ?? 32);
        const { positions, normals, uvs } = deinterleaveGeometry(geometry);
        return this.createMesh({ positions, normals, uvs, textureId: opts.textureId });
    }

    createPlane(opts: { width?: number; height?: number; textureId?: string } = {}): ModelHandle {
        const geometry = builtInPlane({ width: opts.width, height: opts.height });
        const { positions, normals, uvs } = deinterleaveGeometry(geometry);
        return this.createMesh({ positions, normals, uvs, textureId: opts.textureId });
    }

    loadGltf(url: string, opts?: { animations?: string[] }): Promise<GltfModel> {
        return parseGltf(url, opts).then((parsed) => this.uploadParsedGltf(parsed));
    }

    createMesh(data: {
        positions: Float32Array;
        normals?: Float32Array;
        uvs?: Float32Array;
        indices?: Uint16Array | Uint32Array;
        textureId?: string;
    }): ModelHandle {
        const textureId = data.textureId;
        const hasTexture = textureId ? this.deps.textures.has(textureId) : false;
        let textureBindGroup: GPUBindGroup | null = null;
        if (hasTexture && textureId) {
            textureBindGroup = this.deps.textures.get(textureId)!.bindGroup;
        }
        const handle = this.loadModel({
            positions: data.positions,
            normals: data.normals,
            uvs: data.uvs,
            indices: data.indices,
        });
        const model = this.models[handle.id];
        model.hasTexture = hasTexture;
        model.textureBindGroup = textureBindGroup;
        return handle;
    }

    loadModel(data: ModelData): ModelHandle {
        const { positions, indices, texture } = data;
        const vertexCount = positions.length / 3;

        const normals = data.normals ?? this.computeNormals(positions, indices);
        const uvs = data.uvs ?? new Float32Array(vertexCount * 2);
        const hasTexture = !!texture;

        let maxRadiusSq = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < vertexCount; i++) {
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
            const rSq = px * px + py * py + pz * pz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
        }
        const boundingRadius = Math.sqrt(maxRadiusSq);
        const halfX = vertexCount ? (maxX - minX) * 0.5 : 0;
        const halfY = vertexCount ? (maxY - minY) * 0.5 : 0;
        const halfZ = vertexCount ? (maxZ - minZ) * 0.5 : 0;
        const centerX = vertexCount ? (minX + maxX) * 0.5 : 0;
        const centerY = vertexCount ? (minY + maxY) * 0.5 : 0;
        const centerZ = vertexCount ? (minZ + maxZ) * 0.5 : 0;

        // Interleave position(3f) + normal(3f) + uv(2f) = 8 floats per vertex
        const interleaved = new Float32Array(vertexCount * 8);
        for (let i = 0; i < vertexCount; i++) {
            const o = i * 8;
            interleaved[o + 0] = positions[i * 3 + 0];
            interleaved[o + 1] = positions[i * 3 + 1];
            interleaved[o + 2] = positions[i * 3 + 2];
            interleaved[o + 3] = normals[i * 3 + 0];
            interleaved[o + 4] = normals[i * 3 + 1];
            interleaved[o + 5] = normals[i * 3 + 2];
            interleaved[o + 6] = uvs[i * 2 + 0];
            interleaved[o + 7] = uvs[i * 2 + 1];
        }

        const device = this.deps.device;
        const vertexBuffer = device.createBuffer({
            size: interleaved.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(interleaved);
        vertexBuffer.unmap();

        let indexBuffer: GPUBuffer | null = null;
        let indexCount = 0;
        if (indices) {
            indexCount = indices.length;
            const alignedSize = Math.ceil(indices.byteLength / 4) * 4;
            indexBuffer = device.createBuffer({
                size: alignedSize,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            if (indices instanceof Uint16Array) {
                new Uint16Array(indexBuffer.getMappedRange()).set(indices);
            } else {
                new Uint32Array(indexBuffer.getMappedRange()).set(indices);
            }
            indexBuffer.unmap();
        }

        let textureBindGroup: GPUBindGroup | null = null;
        if (texture) {
            const { view } = createTextureFromBitmap(device, texture);
            const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
            textureBindGroup = device.createBindGroup({
                layout: this.deps.pipelines.rawTexturedPipeline.getBindGroupLayout(1),
                entries: [
                    { binding: 0, resource: view },
                    { binding: 1, resource: sampler },
                ],
            });
        }

        if (this.nextModelId >= SparseBatcher.MAX_SHEETS) {
            throw new Error(`Model limit exceeded: modelId ${this.nextModelId} is past SparseBatcher.MAX_SHEETS (${SparseBatcher.MAX_SHEETS})`);
        }
        const id = this.nextModelId++;
        this.models[id] = {
            rawVertexBuffer: vertexBuffer,
            rawIndexBuffer: indexBuffer,
            vertexCount,
            indexCount,
            indexFormat: indices instanceof Uint32Array ? 'uint32' as const : 'uint16' as const,
            boundingRadius,
            halfX, halfY, halfZ,
            centerX, centerY, centerZ,
            hasTexture,
            textureBindGroup,
            skinned: false,
            skinIndex: -1,
        };

        return { id, vertexCount, indexCount, skinned: false };
    }

    private loadSkinnedModel(data: ModelData, skinAttrs: PrimitiveSkinAttributes, skinIndex: number): ModelHandle {
        const { positions, indices, texture } = data;
        const vertexCount = positions.length / 3;
        const normals = data.normals ?? this.computeNormals(positions, indices);
        const uvs = data.uvs ?? new Float32Array(vertexCount * 2);
        const hasTexture = !!texture;

        let maxRadiusSq = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < vertexCount; i++) {
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
            const rSq = px * px + py * py + pz * pz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
        }
        const boundingRadius = Math.sqrt(maxRadiusSq);
        const halfX = vertexCount ? (maxX - minX) * 0.5 : 0;
        const halfY = vertexCount ? (maxY - minY) * 0.5 : 0;
        const halfZ = vertexCount ? (maxZ - minZ) * 0.5 : 0;
        const centerX = vertexCount ? (minX + maxX) * 0.5 : 0;
        const centerY = vertexCount ? (minY + maxY) * 0.5 : 0;
        const centerZ = vertexCount ? (minZ + maxZ) * 0.5 : 0;

        // Interleave: pos(3f) + normal(3f) + uv(2f) + joints(4xu16) + weights(4f) = 56 bytes
        const buf = new ArrayBuffer(vertexCount * 56);
        const floatView = new Float32Array(buf);
        const u16View = new Uint16Array(buf);

        for (let i = 0; i < vertexCount; i++) {
            const fBase = i * 14;
            const u16Base = i * 28;

            floatView[fBase + 0] = positions[i * 3 + 0];
            floatView[fBase + 1] = positions[i * 3 + 1];
            floatView[fBase + 2] = positions[i * 3 + 2];
            floatView[fBase + 3] = normals[i * 3 + 0];
            floatView[fBase + 4] = normals[i * 3 + 1];
            floatView[fBase + 5] = normals[i * 3 + 2];
            floatView[fBase + 6] = uvs[i * 2 + 0];
            floatView[fBase + 7] = uvs[i * 2 + 1];
            u16View[u16Base + 16] = skinAttrs.joints[i * 4 + 0];
            u16View[u16Base + 17] = skinAttrs.joints[i * 4 + 1];
            u16View[u16Base + 18] = skinAttrs.joints[i * 4 + 2];
            u16View[u16Base + 19] = skinAttrs.joints[i * 4 + 3];
            floatView[fBase + 10] = skinAttrs.weights[i * 4 + 0];
            floatView[fBase + 11] = skinAttrs.weights[i * 4 + 1];
            floatView[fBase + 12] = skinAttrs.weights[i * 4 + 2];
            floatView[fBase + 13] = skinAttrs.weights[i * 4 + 3];
        }

        const device = this.deps.device;
        const vertexBuffer = device.createBuffer({
            size: buf.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint8Array(vertexBuffer.getMappedRange()).set(new Uint8Array(buf));
        vertexBuffer.unmap();

        let indexBuffer: GPUBuffer | null = null;
        let indexCount = 0;
        if (indices) {
            indexCount = indices.length;
            const alignedSize = Math.ceil(indices.byteLength / 4) * 4;
            indexBuffer = device.createBuffer({
                size: alignedSize,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            if (indices instanceof Uint16Array) {
                new Uint16Array(indexBuffer.getMappedRange()).set(indices);
            } else {
                new Uint32Array(indexBuffer.getMappedRange()).set(indices);
            }
            indexBuffer.unmap();
        }

        let textureBindGroup: GPUBindGroup | null = null;
        if (texture) {
            const { view } = createTextureFromBitmap(device, texture);
            const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
            textureBindGroup = device.createBindGroup({
                layout: this.deps.pipelines.rawSkinnedTexturedPipeline.getBindGroupLayout(1),
                entries: [
                    { binding: 0, resource: view },
                    { binding: 1, resource: sampler },
                ],
            });
        }

        if (this.nextModelId >= SparseBatcher.MAX_SHEETS) {
            throw new Error(`Model limit exceeded: modelId ${this.nextModelId} is past SparseBatcher.MAX_SHEETS (${SparseBatcher.MAX_SHEETS})`);
        }
        const id = this.nextModelId++;
        this.models[id] = {
            rawVertexBuffer: vertexBuffer,
            rawIndexBuffer: indexBuffer,
            vertexCount,
            indexCount,
            indexFormat: indices instanceof Uint32Array ? 'uint32' as const : 'uint16' as const,
            boundingRadius,
            halfX, halfY, halfZ,
            centerX, centerY, centerZ,
            hasTexture,
            textureBindGroup,
            skinned: true,
            skinIndex,
        };

        return { id, vertexCount, indexCount, skinned: true };
    }

    private computeNormals(positions: Float32Array, indices?: Uint16Array | Uint32Array): Float32Array {
        const vertexCount = positions.length / 3;
        const normals = new Float32Array(vertexCount * 3);
        const triCount = indices ? indices.length / 3 : vertexCount / 3;

        for (let t = 0; t < triCount; t++) {
            const i0 = indices ? indices[t * 3 + 0] : t * 3 + 0;
            const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
            const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

            const ax = positions[i1 * 3] - positions[i0 * 3];
            const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
            const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
            const bx = positions[i2 * 3] - positions[i0 * 3];
            const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
            const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

            const nx = ay * bz - az * by;
            const ny = az * bx - ax * bz;
            const nz = ax * by - ay * bx;

            for (const idx of [i0, i1, i2]) {
                normals[idx * 3 + 0] += nx;
                normals[idx * 3 + 1] += ny;
                normals[idx * 3 + 2] += nz;
            }
        }

        for (let i = 0; i < vertexCount; i++) {
            const o = i * 3;
            const len = Math.sqrt(normals[o] * normals[o] + normals[o + 1] * normals[o + 1] + normals[o + 2] * normals[o + 2]);
            if (len > 0) {
                const inv = 1 / len;
                normals[o] *= inv;
                normals[o + 1] *= inv;
                normals[o + 2] *= inv;
            } else {
                normals[o + 1] = 1;
            }
        }

        return normals;
    }

    uploadParsedGltf(parsed: ParsedGltf): GltfModel {
        let skinnedModelSkinIndex = -1;

        if (parsed.skin) {
            const { data: skinData, animClips } = parsed.skin;

            const animation = new SkeletalAnimation(skinData, animClips);

            const ibm = skinData.inverseBindMatrices;
            let maxRadSq = 0;
            for (let j = 0; j < skinData.jointCount; j++) {
                const tx = ibm[j * 16 + 12], ty = ibm[j * 16 + 13], tz = ibm[j * 16 + 14];
                const rSq = tx * tx + ty * ty + tz * tz;
                if (rSq > maxRadSq) maxRadSq = rSq;
            }
            const skinnedRadius = Math.sqrt(maxRadSq) * 1.5;

            skinnedModelSkinIndex = this.skinnedModels.length;
            this.skinnedModels.push({
                animation,
                jointCount: skinData.jointCount,
                boundingRadius: skinnedRadius,
                parsedSkin: parsed.skin,
            });

            this.deps.onSkinLoaded(skinData, animClips);
        }

        const handles: ModelHandle[] = [];
        for (const prim of parsed.primitives) {
            if (prim.skinned && prim.skinAttrs) {
                handles.push(this.loadSkinnedModel(
                    {
                        positions: prim.positions,
                        normals: prim.normals,
                        uvs: prim.uvs,
                        indices: prim.indices,
                        texture: prim.texture,
                    },
                    prim.skinAttrs,
                    skinnedModelSkinIndex,
                ));
            } else {
                handles.push(this.loadModel({
                    positions: prim.positions,
                    normals: prim.normals,
                    uvs: prim.uvs,
                    indices: prim.indices,
                    texture: prim.texture,
                }));
            }
        }

        let totalVertexCount = 0;
        for (const h of handles) totalVertexCount += h.vertexCount;

        const animNames = skinnedModelSkinIndex >= 0
            ? this.skinnedModels[skinnedModelSkinIndex].animation.getClipNames()
            : [];

        return {
            parts: handles,
            totalVertexCount,
            skinned: handles.some(h => h.skinned),
            animations: animNames,
            src: parsed.src,
        };
    }
}

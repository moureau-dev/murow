/**
 * WebGPU3DRenderer — instanced 3D mesh renderer backed by TypeGPU.
 *
 * - One draw call per model type (all instances batched)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation + TRS transform in vertex shader
 * - GPU index buffer for sparse instancing
 * - Depth testing + back-face culling
 */
import tgpu from 'typegpu';
import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import * as d from 'typegpu/data';
import { Base3DRenderer } from 'murow/renderer/base-3d-renderer';
import type { Renderer3DOptions } from 'murow/renderer/types';
import { FreeList } from 'murow/core/free-list';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import { ComputeBuilder, type ComputeOptions } from '../compute/compute-builder';
import {
    DYNAMIC_MESH_FLOATS,
    STATIC_MESH_FLOATS,
    SKINNED_STATIC_MESH_FLOATS,
    DynamicMesh,
    StaticMesh,
    SkinnedStaticMesh,
    MeshUniforms,
} from '../core/types';
import { Camera3D } from '../camera/camera-3d';
import { createTextureFromBitmap } from '../spritesheet/spritesheet';
import {
    createMeshLayout,
    createMeshVertex,
    createMeshFragment,
    createTextureBindGroupLayout,
    createTexturedMeshVertex,
    createTexturedMeshFragment,
    createSkinnedMeshLayout,
    createSkinnedMeshVertex,
    createSkinnedMeshFragment,
    createSkinnedTexturedMeshFragment,
    type MeshDataLayout,
    type SkinnedMeshDataLayout,
} from './shader';
import { nodeToMat4 } from '../core/math';
import { parseSkin, parseAnimations, parsePrimitiveSkinAttributes, createPackedAnimationData, packSkinAndAnimations, type SkinData, type AnimationClipData, type PrimitiveSkinAttributes, type PackedAnimationData } from './gltf-skin-parser';
import { SkeletalAnimation, type SkeletalAnimState, type PlayOptions } from './skeletal-animation';
import { buildAnimationKernel } from './skeletal-animation-compute/index';
import type { ComputeKernel } from '../compute/compute-builder';

// --- Dynamic offset constants ---
const DYN_PREV_PX = 0, DYN_PREV_PY = 1, DYN_PREV_PZ = 2;
const DYN_CURR_PX = 3, DYN_CURR_PY = 4, DYN_CURR_PZ = 5;
const DYN_PREV_RX = 6, DYN_PREV_RY = 7, DYN_PREV_RZ = 8;
const DYN_CURR_RX = 9, DYN_CURR_RY = 10, DYN_CURR_RZ = 11;

// --- Static offset constants ---
const STAT_SX = 0, STAT_SY = 1, STAT_SZ = 2;
const STAT_CR = 3, STAT_CG = 4, STAT_CB = 5;

// --- Skinned static offset constants (extra boneOffset) ---
const SSTAT_SX = 0, SSTAT_SY = 1, SSTAT_SZ = 2;
const SSTAT_CR = 3, SSTAT_CG = 4, SSTAT_CB = 5;
const SSTAT_BONE_OFFSET = 6;

// Default limits for skinned rendering
const DEFAULT_MAX_SKINNED_INSTANCES = 4000;
const DEFAULT_MAX_BONES_PER_SKIN = 64;
const DEFAULT_MAX_TOTAL_BONES = DEFAULT_MAX_SKINNED_INSTANCES * DEFAULT_MAX_BONES_PER_SKIN * 2; // 2x for world + final bone matrices (~32MB)

export interface ModelData {
    positions: Float32Array;
    normals?: Float32Array;
    uvs?: Float32Array;
    indices?: Uint16Array | Uint32Array;
    texture?: ImageBitmap;
}

export interface ModelHandle {
    readonly id: number;
    readonly vertexCount: number;
    readonly indexCount: number;
    readonly skinned: boolean;
}

export interface MeshInstanceHandle {
    readonly slot: number;
    readonly modelId: number;
    readonly skinned: boolean;
    setPosition(x: number, y: number, z: number): void;
    setRotation(x: number, y: number, z: number): void;
    setScale(x: number, y: number, z: number): void;
    play?(name: string, opts?: PlayOptions): void;
    stop?(): void;
}

/** A loaded glTF model — may contain multiple mesh parts that share a skeleton. */
export interface GltfModel {
    readonly parts: ModelHandle[];
    readonly totalVertexCount: number;
    readonly skinned: boolean;
    /** Animation clip names available on this model (empty if not skinned). */
    readonly animations: string[];
    /** Source URL this model was loaded from. */
    readonly src: string;
}

/** Handle to a spawned instance (single primitive or multi-part glTF). */
export interface InstanceHandle {
    setPosition(x: number, y: number, z: number): void;
    setRotation(x: number, y: number, z: number): void;
    setScale(x: number, y: number, z: number): void;
    play?(name: string, opts?: PlayOptions): void;
    stop?(): void;
    readonly skinned: boolean;
}

export interface MeshInstanceOptions {
    model: ModelHandle | GltfModel;
    x?: number; y?: number; z?: number;
    rotX?: number; rotY?: number; rotZ?: number;
    scaleX?: number; scaleY?: number; scaleZ?: number;
    color?: [number, number, number];
}

export class WebGPU3DRenderer extends Base3DRenderer {
    private root!: TgpuRoot;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private resizeObserver: ResizeObserver | null = null;
    private resizeCallbacks: ((width: number, height: number) => void)[] = [];
    private format!: GPUTextureFormat;

    // TypeGPU layout
    private meshLayout!: MeshDataLayout;

    // CPU-side data
    private dynamicData: Float32Array;
    private staticData: Float32Array;
    private slotIndexData: Uint32Array;
    private freeList: FreeList;
    private batcher: SparseBatcher; // layer=0, sheetId=modelId
    private staticDirty = false;

    // Per-instance model ID (for batcher lookup on remove)
    private instanceModelIds: Uint8Array;

    // TypeGPU buffers
    private dynamicBuffer!: TgpuBuffer<any>;
    private staticBuffer!: TgpuBuffer<any>;
    private uniformBuffer!: TgpuBuffer<any>;
    private slotIndexBuffer!: TgpuBuffer<any>;

    // Raw GPU resources
    private rawPipeline!: GPURenderPipeline;
    private rawBindGroup!: GPUBindGroup;
    private rawDynamicBuffer!: GPUBuffer;
    private rawStaticBuffer!: GPUBuffer;
    private rawUniformBuffer!: GPUBuffer;
    private rawSlotIndexBuffer!: GPUBuffer;

    // Depth texture
    private depthTexture!: GPUTexture;

    // Textured pipeline
    private rawTexturedPipeline!: GPURenderPipeline;

    // Models (vertex + index buffers)
    private models: {
        rawVertexBuffer: GPUBuffer;
        rawIndexBuffer: GPUBuffer | null;
        vertexCount: number;
        indexCount: number;
        indexFormat: GPUIndexFormat;
        boundingRadius: number;
        hasTexture: boolean;
        textureBindGroup: GPUBindGroup | null;
        skinned: boolean;
        skinIndex: number; // index into skinnedModels, or -1
    }[] = [];
    private nextModelId = 0;

    // Skinned model data
    private skinnedModels: {
        animation: SkeletalAnimation;
        jointCount: number;
        boundingRadius: number; // max distance from root to any joint in bind pose
    }[] = [];

    // Skinned pipeline resources
    private skinnedMeshLayout!: SkinnedMeshDataLayout;
    private rawSkinnedPipeline!: GPURenderPipeline;
    private rawSkinnedTexturedPipeline!: GPURenderPipeline;
    private rawSkinnedBindGroup!: GPUBindGroup;

    // Bone matrix buffer — owned by compute kernel, shared with render pipeline
    private boneMatrixData!: Float32Array; // CPU fallback / rest pose init
    private rawBoneMatrixBuffer!: GPUBuffer;
    private boneMatrixDirty = true;
    private maxTotalBones = DEFAULT_MAX_TOTAL_BONES;

    // GPU animation compute
    private packedAnimData: PackedAnimationData = createPackedAnimationData();
    private animComputeKernel: ComputeKernel | null = null;
    private animComputeNeedsRebuild = false;
    private animClipTableOffset = 0;
    private animChannelTableOffset = 0;
    private animJointLookupOffset = 0;
    private gpuAnimInstanceStates: { clipId: number; time: number; skinIndex: number; boneOffset: number; prevClipId: number; prevTime: number; blendWeight: number; _pad: number }[] = [];
    private gpuInstData!: Float32Array;
    private gpuInstDV!: DataView;

    // Per-instance skinned state
    private skinnedDynamicData!: Float32Array;
    private skinnedStaticData!: Float32Array;
    private skinnedSlotIndexData!: Uint32Array;
    private skinnedFreeList!: FreeList;
    private skinnedBatcher!: SparseBatcher;
    private skinnedStaticDirty = false;
    private skinnedInstanceModelIds!: Uint8Array;
    private skinnedInstanceBoneOffsets!: Uint32Array;
    private skinnedAnimStates: (SkeletalAnimState | null)[] = [];
    private nextBoneOffset = 0;
    private maxSkinnedInstances = DEFAULT_MAX_SKINNED_INSTANCES;

    // Raw skinned GPU buffers
    private rawSkinnedDynamicBuffer!: GPUBuffer;
    private rawSkinnedStaticBuffer!: GPUBuffer;
    private rawSkinnedUniformBuffer!: GPUBuffer; // shares uniform data with non-skinned
    private rawSkinnedSlotIndexBuffer!: GPUBuffer;

    // Frustum planes (6 planes × 4 floats each), extracted from VP matrix
    private frustumPlanes = new Float32Array(24);

    readonly camera: Camera3D;
    private uniformData = new Float32Array(24); // mat4x4 (16) + alpha (1) + lightDir (3) + padding (4)
    private lastRenderTime = 0;

    constructor(canvas: HTMLCanvasElement, options: Renderer3DOptions) {
        super(canvas, options);
        this.camera = new Camera3D();

        // Non-skinned instance buffers
        this.freeList = new FreeList(options.maxModels);
        this.batcher = new SparseBatcher(options.maxModels);
        this.dynamicData = new Float32Array(options.maxModels * DYNAMIC_MESH_FLOATS);
        this.staticData = new Float32Array(options.maxModels * STATIC_MESH_FLOATS);
        this.slotIndexData = new Uint32Array(options.maxModels);
        this.instanceModelIds = new Uint8Array(options.maxModels);

        // Skinned instance buffers
        const msi = this.maxSkinnedInstances;
        this.skinnedFreeList = new FreeList(msi);
        this.skinnedBatcher = new SparseBatcher(msi);
        this.skinnedDynamicData = new Float32Array(msi * DYNAMIC_MESH_FLOATS);
        this.skinnedStaticData = new Float32Array(msi * SKINNED_STATIC_MESH_FLOATS);
        this.skinnedSlotIndexData = new Uint32Array(msi);
        this.skinnedInstanceModelIds = new Uint8Array(msi);
        this.skinnedInstanceBoneOffsets = new Uint32Array(msi);
        this.skinnedAnimStates = new Array(msi).fill(null);

        // Bone matrix buffer (CPU side)
        this.boneMatrixData = new Float32Array(this.maxTotalBones * 16);

        // Pre-allocated buffer for GPU compute instance state upload (8 floats per instance)
        const instBufSize = msi * 8;
        this.gpuInstData = new Float32Array(instBufSize);
        this.gpuInstDV = new DataView(this.gpuInstData.buffer);
    }

    async init(): Promise<void> {
        this.root = await tgpu.init();
        this.device = this.root.device;

        this.context = this.canvas.getContext('webgpu')!;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.camera.aspect = this._width / this._height;

        // Depth texture
        this.depthTexture = this.device.createTexture({
            size: [this._width, this._height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // TypeGPU layouts + shaders
        this.meshLayout = createMeshLayout(this.maxModels);

        // Shared depth/stencil and primitive config
        const depthStencil: GPUDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less',
        };
        const primitive: GPUPrimitiveState = {
            topology: 'triangle-list',
            cullMode: 'none',
        };

        // Vertex buffer layout: position(3f) + normal(3f) + uv(2f) = 32 bytes
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 32,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
                { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
            ],
        };

        // --- Untextured pipeline (color only) ---
        const vertex = createMeshVertex(this.meshLayout);
        const fragment = createMeshFragment(this.meshLayout);
        const { code: wgslCode } = tgpu.resolveWithContext([vertex, fragment]);
        const shaderModule = this.device.createShaderModule({ code: wgslCode });
        const rawBGL = this.root.unwrap(this.meshLayout);

        this.rawPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [rawBGL] }),
            vertex: { module: shaderModule, buffers: [vertexBufferLayout] },
            fragment: { module: shaderModule, targets: [{ format: this.format }] },
            primitive,
            depthStencil,
        });

        // --- Textured pipeline (texture + color tint) ---
        const texLayout = createTextureBindGroupLayout();
        const texVertex = createTexturedMeshVertex(this.meshLayout);
        const texFragment = createTexturedMeshFragment(this.meshLayout, texLayout);
        const { code: texWgslCode } = tgpu.resolveWithContext([texVertex, texFragment]);
        const texShaderModule = this.device.createShaderModule({ code: texWgslCode });
        const rawTexBGL = this.root.unwrap(texLayout);

        this.rawTexturedPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [rawBGL, rawTexBGL] }),
            vertex: { module: texShaderModule, buffers: [vertexBufferLayout] },
            fragment: { module: texShaderModule, targets: [{ format: this.format }] },
            primitive,
            depthStencil,
        });

        // Buffers
        this.dynamicBuffer = this.root.createBuffer(d.arrayOf(DynamicMesh, this.maxModels)).$usage('storage');
        this.staticBuffer = this.root.createBuffer(d.arrayOf(StaticMesh, this.maxModels)).$usage('storage');
        this.uniformBuffer = this.root.createBuffer(MeshUniforms).$usage('uniform');
        this.slotIndexBuffer = this.root.createBuffer(d.arrayOf(d.u32, this.maxModels)).$usage('storage');

        // Bind group (raw, using TypeGPU layout)
        this.rawDynamicBuffer = this.root.unwrap(this.dynamicBuffer) as any;
        this.rawStaticBuffer = this.root.unwrap(this.staticBuffer) as any;
        this.rawUniformBuffer = this.root.unwrap(this.uniformBuffer) as any;
        this.rawSlotIndexBuffer = this.root.unwrap(this.slotIndexBuffer) as any;

        this.rawBindGroup = this.device.createBindGroup({
            layout: rawBGL,
            entries: [
                { binding: 0, resource: { buffer: this.rawUniformBuffer } },
                { binding: 1, resource: { buffer: this.rawDynamicBuffer } },
                { binding: 2, resource: { buffer: this.rawStaticBuffer } },
                { binding: 3, resource: { buffer: this.rawSlotIndexBuffer } },
            ],
        });

        // --- Skinned pipelines ---
        const msi = this.maxSkinnedInstances;
        this.skinnedMeshLayout = createSkinnedMeshLayout(msi, this.maxTotalBones);

        // Skinned vertex buffer: pos(3f) + normal(3f) + uv(2f) + joints(4xu16) + weights(4f) = 56 bytes
        const skinnedVertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 56,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
                { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
                { shaderLocation: 2, offset: 24, format: 'float32x2' },  // uv
                { shaderLocation: 3, offset: 32, format: 'uint16x4' },   // joints
                { shaderLocation: 4, offset: 40, format: 'float32x4' },  // weights
            ],
        };

        const skinnedVertex = createSkinnedMeshVertex(this.skinnedMeshLayout);
        const skinnedFragment = createSkinnedMeshFragment(this.skinnedMeshLayout);
        const { code: skinnedWgsl } = tgpu.resolveWithContext([skinnedVertex, skinnedFragment]);
        const skinnedShaderModule = this.device.createShaderModule({ code: skinnedWgsl });
        const rawSkinnedBGL = this.root.unwrap(this.skinnedMeshLayout);

        this.rawSkinnedPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [rawSkinnedBGL] }),
            vertex: { module: skinnedShaderModule, buffers: [skinnedVertexBufferLayout] },
            fragment: { module: skinnedShaderModule, targets: [{ format: this.format }] },
            primitive,
            depthStencil,
        });

        // Skinned + textured pipeline
        const skinnedTexVertex = createSkinnedMeshVertex(this.skinnedMeshLayout);
        const skinnedTexFragment = createSkinnedTexturedMeshFragment(this.skinnedMeshLayout, texLayout);
        const { code: skinnedTexWgsl } = tgpu.resolveWithContext([skinnedTexVertex, skinnedTexFragment]);
        const skinnedTexShaderModule = this.device.createShaderModule({ code: skinnedTexWgsl });

        this.rawSkinnedTexturedPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [rawSkinnedBGL, rawTexBGL] }),
            vertex: { module: skinnedTexShaderModule, buffers: [skinnedVertexBufferLayout] },
            fragment: { module: skinnedTexShaderModule, targets: [{ format: this.format }] },
            primitive,
            depthStencil,
        });

        // Skinned GPU buffers
        const skinnedDynBuf = this.root.createBuffer(d.arrayOf(DynamicMesh, msi)).$usage('storage');
        const skinnedStatBuf = this.root.createBuffer(d.arrayOf(SkinnedStaticMesh, msi)).$usage('storage');
        const skinnedSlotBuf = this.root.createBuffer(d.arrayOf(d.u32, msi)).$usage('storage');
        const boneBuf = this.root.createBuffer(d.arrayOf(d.mat4x4f, this.maxTotalBones)).$usage('storage');

        this.rawSkinnedDynamicBuffer = this.root.unwrap(skinnedDynBuf) as any;
        this.rawSkinnedStaticBuffer = this.root.unwrap(skinnedStatBuf) as any;
        this.rawSkinnedSlotIndexBuffer = this.root.unwrap(skinnedSlotBuf) as any;
        this.rawBoneMatrixBuffer = this.root.unwrap(boneBuf) as any;

        this.rawSkinnedBindGroup = this.device.createBindGroup({
            layout: rawSkinnedBGL,
            entries: [
                { binding: 0, resource: { buffer: this.rawUniformBuffer } },
                { binding: 1, resource: { buffer: this.rawSkinnedDynamicBuffer } },
                { binding: 2, resource: { buffer: this.rawSkinnedStaticBuffer } },
                { binding: 3, resource: { buffer: this.rawSkinnedSlotIndexBuffer } },
                { binding: 4, resource: { buffer: this.rawBoneMatrixBuffer } },
            ],
        });

        this.setupResizeObserver();
        this._initialized = true;
    }

    private setupResizeObserver(): void {
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const box = entry.devicePixelContentBoxSize?.[0] ?? entry.contentBoxSize[0];
                const w = box.inlineSize;
                const h = box.blockSize;
                if (w === this._width && h === this._height) continue;
                this._width = w;
                this._height = h;

                if (this.options.autoResize) {
                    this.canvas.width = w;
                    this.canvas.height = h;
                    this.context.configure({
                        device: this.device,
                        format: navigator.gpu.getPreferredCanvasFormat(),
                        alphaMode: 'premultiplied',
                    });
                }

                this.camera.aspect = w / h;

                // Recreate depth texture
                this.depthTexture.destroy();
                this.depthTexture = this.device.createTexture({
                    size: [w, h],
                    format: 'depth24plus',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT,
                });

                for (const cb of this.resizeCallbacks) {
                    cb(w, h);
                }
            }
        });
        this.resizeObserver.observe(this.canvas, { box: 'device-pixel-content-box' });
    }

    /**
     * Register a callback that fires when the canvas resizes.
     * Receives the new width and height in physical pixels.
     */
    onResize(callback: (width: number, height: number) => void): void {
        this.resizeCallbacks.push(callback);
    }

    createCompute(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.root);
    }

    /**
     * Create a flat grid mesh on the XZ plane at Y=0.
     *
     * ```ts
     * const grid = renderer.createGrid({ size: 20, step: 1, lineWidth: 0.005 });
     * renderer.addInstance({ model: grid, color: [0.3, 0.3, 0.3] });
     * ```
     */
    createGrid(opts: { size?: number; step?: number; lineWidth?: number } = {}): ModelHandle {
        const size = opts.size ?? 20;
        const step = opts.step ?? 1;
        const lw = opts.lineWidth ?? 0.005;

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];

        for (let i = -size; i <= size; i += step) {
            const idx = positions.length / 3;
            // Line along Z
            positions.push(i - lw, 0, -size, i + lw, 0, -size, i + lw, 0, size, i - lw, 0, size);
            normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
            indices.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);

            const idx2 = positions.length / 3;
            // Line along X
            positions.push(-size, 0, i - lw, size, 0, i - lw, size, 0, i + lw, -size, 0, i + lw);
            normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
            indices.push(idx2, idx2 + 1, idx2 + 2, idx2, idx2 + 2, idx2 + 3);
        }

        return this.loadModel({
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            indices: new Uint16Array(indices),
        });
    }

    /**
     * Register a model. Returns a handle for addInstance().
     *
     * ```ts
     * const hero = renderer.loadModel({
     *     positions: new Float32Array([...]),
     *     normals: new Float32Array([...]),  // optional — auto-computed from faces
     *     uvs: new Float32Array([...]),       // optional
     *     indices: new Uint16Array([...]),    // optional
     *     texture: myImageBitmap,             // optional
     * });
     * ```
     */
    loadModel(data: ModelData): ModelHandle {
        const { positions, indices, texture } = data;
        const vertexCount = positions.length / 3;

        // Auto-compute normals if not provided
        const normals = data.normals ?? this.computeNormals(positions, indices);

        // UVs: use provided or default to zeros
        const uvs = data.uvs ?? new Float32Array(vertexCount * 2);
        const hasTexture = !!texture;

        // Compute bounding radius (max distance from origin)
        let maxRadiusSq = 0;
        for (let i = 0; i < vertexCount; i++) {
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
            const rSq = px * px + py * py + pz * pz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        const boundingRadius = Math.sqrt(maxRadiusSq);

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

        const vertexBuffer = this.device.createBuffer({
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
            // Buffer size must be aligned to 4 bytes (COPY_BUFFER_ALIGNMENT)
            const alignedSize = Math.ceil(indices.byteLength / 4) * 4;
            indexBuffer = this.device.createBuffer({
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

        // Create per-model texture bind group if texture provided
        let textureBindGroup: GPUBindGroup | null = null;
        if (texture) {
            const { texture: gpuTexture, view } = createTextureFromBitmap(this.device, texture);
            const sampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
            });
            textureBindGroup = this.device.createBindGroup({
                layout: this.rawTexturedPipeline.getBindGroupLayout(1),
                entries: [
                    { binding: 0, resource: view },
                    { binding: 1, resource: sampler },
                ],
            });
        }

        const id = this.nextModelId++;
        this.models[id] = {
            rawVertexBuffer: vertexBuffer,
            rawIndexBuffer: indexBuffer,
            vertexCount,
            indexCount,
            indexFormat: indices instanceof Uint32Array ? 'uint32' as const : 'uint16' as const,
            boundingRadius,
            hasTexture,
            textureBindGroup,
            skinned: false,
            skinIndex: -1,
        };

        return { id, vertexCount, indexCount, skinned: false };
    }

    /**
     * Register a skinned model with joint/weight vertex data.
     * Called internally by loadGltf when a skin is detected.
     */
    private loadSkinnedModel(
        data: ModelData,
        skinAttrs: PrimitiveSkinAttributes,
        skinIndex: number,
    ): ModelHandle {
        const { positions, indices, texture } = data;
        const vertexCount = positions.length / 3;
        const normals = data.normals ?? this.computeNormals(positions, indices);
        const uvs = data.uvs ?? new Float32Array(vertexCount * 2);
        const hasTexture = !!texture;

        // Compute bounding radius
        let maxRadiusSq = 0;
        for (let i = 0; i < vertexCount; i++) {
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
            const rSq = px * px + py * py + pz * pz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        const boundingRadius = Math.sqrt(maxRadiusSq);

        // Interleave: pos(3f) + normal(3f) + uv(2f) + joints(4xu16) + weights(4f) = 56 bytes
        const buf = new ArrayBuffer(vertexCount * 56);
        const floatView = new Float32Array(buf);
        const u16View = new Uint16Array(buf);

        for (let i = 0; i < vertexCount; i++) {
            const fBase = i * 14; // 56 bytes / 4 = 14 floats per vertex
            const u16Base = i * 28; // 56 bytes / 2 = 28 u16s per vertex

            // position (3f) at byte 0
            floatView[fBase + 0] = positions[i * 3 + 0];
            floatView[fBase + 1] = positions[i * 3 + 1];
            floatView[fBase + 2] = positions[i * 3 + 2];
            // normal (3f) at byte 12
            floatView[fBase + 3] = normals[i * 3 + 0];
            floatView[fBase + 4] = normals[i * 3 + 1];
            floatView[fBase + 5] = normals[i * 3 + 2];
            // uv (2f) at byte 24
            floatView[fBase + 6] = uvs[i * 2 + 0];
            floatView[fBase + 7] = uvs[i * 2 + 1];
            // joints (4xu16) at byte 32
            u16View[u16Base + 16] = skinAttrs.joints[i * 4 + 0];
            u16View[u16Base + 17] = skinAttrs.joints[i * 4 + 1];
            u16View[u16Base + 18] = skinAttrs.joints[i * 4 + 2];
            u16View[u16Base + 19] = skinAttrs.joints[i * 4 + 3];
            // weights (4f) at byte 40
            floatView[fBase + 10] = skinAttrs.weights[i * 4 + 0];
            floatView[fBase + 11] = skinAttrs.weights[i * 4 + 1];
            floatView[fBase + 12] = skinAttrs.weights[i * 4 + 2];
            floatView[fBase + 13] = skinAttrs.weights[i * 4 + 3];
        }

        const vertexBuffer = this.device.createBuffer({
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
            indexBuffer = this.device.createBuffer({
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

        // Texture bind group
        let textureBindGroup: GPUBindGroup | null = null;
        if (texture) {
            const { texture: gpuTexture, view } = createTextureFromBitmap(this.device, texture);
            const sampler = this.device.createSampler({
                magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
            });
            textureBindGroup = this.device.createBindGroup({
                layout: this.rawSkinnedTexturedPipeline.getBindGroupLayout(1),
                entries: [
                    { binding: 0, resource: view },
                    { binding: 1, resource: sampler },
                ],
            });
        }

        const id = this.nextModelId++;
        this.models[id] = {
            rawVertexBuffer: vertexBuffer,
            rawIndexBuffer: indexBuffer,
            vertexCount,
            indexCount,
            indexFormat: indices instanceof Uint32Array ? 'uint32' as const : 'uint16' as const,
            boundingRadius,
            hasTexture,
            textureBindGroup,
            skinned: true,
            skinIndex,
        };

        return { id, vertexCount, indexCount, skinned: true };
    }

    /**
     * Auto-compute flat normals from triangle faces.
     */
    private computeNormals(positions: Float32Array, indices?: Uint16Array | Uint32Array): Float32Array {
        const vertexCount = positions.length / 3;
        const normals = new Float32Array(vertexCount * 3);
        const triCount = indices ? indices.length / 3 : vertexCount / 3;

        for (let t = 0; t < triCount; t++) {
            const i0 = indices ? indices[t * 3 + 0] : t * 3 + 0;
            const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
            const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

            // Edge vectors
            const ax = positions[i1 * 3] - positions[i0 * 3];
            const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
            const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
            const bx = positions[i2 * 3] - positions[i0 * 3];
            const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
            const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

            // Cross product (area-weighted)
            const nx = ay * bz - az * by;
            const ny = az * bx - ax * bz;
            const nz = ax * by - ay * bx;

            // Accumulate per vertex (smooth normals)
            for (const idx of [i0, i1, i2]) {
                normals[idx * 3 + 0] += nx;
                normals[idx * 3 + 1] += ny;
                normals[idx * 3 + 2] += nz;
            }
        }

        // Normalize
        for (let i = 0; i < vertexCount; i++) {
            const o = i * 3;
            const len = Math.sqrt(normals[o] * normals[o] + normals[o + 1] * normals[o + 1] + normals[o + 2] * normals[o + 2]);
            if (len > 0) {
                const inv = 1 / len;
                normals[o] *= inv;
                normals[o + 1] *= inv;
                normals[o + 2] *= inv;
            } else {
                normals[o + 1] = 1; // default up
            }
        }

        return normals;
    }

    /**
     * Load a glTF/GLB model from a URL. Returns one ModelHandle per primitive.
     * Most models have multiple primitives (body parts, material groups, etc.).
     *
     * ```ts
     * const model = await renderer.loadGltf('assets/hero.glb');
     * const instance = renderer.addInstance({ model, x: 0, y: 0, z: 0 });
     * instance.playAnimation?.('walk');
     * ```
     */
    async loadGltf(url: string, opts?: { animations?: string[] }): Promise<GltfModel> {
        const response = await fetch(url);
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

        let gltf: any;
        let glbBinaryChunk: ArrayBuffer | null = null;

        // Detect .glb (binary) vs .gltf (JSON)
        const arrayBuffer = await response.arrayBuffer();
        const magic = new Uint32Array(arrayBuffer, 0, 1)[0];

        if (magic === 0x46546C67) {
            // GLB: magic "glTF" (little-endian 0x46546C67)
            let offset = 12; // past header

            // Read chunks
            while (offset < arrayBuffer.byteLength) {
                const chunkLength = new Uint32Array(arrayBuffer, offset, 1)[0];
                const chunkType = new Uint32Array(arrayBuffer, offset + 4, 1)[0];
                offset += 8;

                if (chunkType === 0x4E4F534A) {
                    // JSON chunk
                    const jsonBytes = new Uint8Array(arrayBuffer, offset, chunkLength);
                    gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
                } else if (chunkType === 0x004E4942) {
                    // BIN chunk
                    glbBinaryChunk = arrayBuffer.slice(offset, offset + chunkLength);
                }

                offset += chunkLength;
            }

            if (!gltf) throw new Error(`Invalid GLB: no JSON chunk in ${url}`);
        } else {
            // Plain .gltf JSON
            gltf = JSON.parse(new TextDecoder().decode(arrayBuffer));
        }

        if (!gltf.meshes?.length) throw new Error(`No meshes found in ${url}`);

        // Load binary buffers
        const buffers: ArrayBuffer[] = [];
        for (let i = 0; i < (gltf.buffers?.length ?? 0); i++) {
            const buf = gltf.buffers[i];
            if (glbBinaryChunk && (!buf.uri || buf.uri === '')) {
                buffers.push(glbBinaryChunk);
            } else if (buf.uri) {
                const r = await fetch(baseUrl + buf.uri);
                buffers.push(await r.arrayBuffer());
            }
        }

        // Helper: extract typed array from accessor (handles interleaved/strided bufferViews)
        const getAccessorData = (accessorIndex: number): { data: Float32Array | Uint16Array | Uint32Array | Uint8Array; count: number; elementSize: number } => {
            const accessor = gltf.accessors[accessorIndex];
            const bufferView = gltf.bufferViews[accessor.bufferView];
            const buffer = buffers[bufferView.buffer];

            const typeMap: Record<number, any> = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
            const byteSizeMap: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
            const sizeMap: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

            const TypedArray = typeMap[accessor.componentType];
            const componentBytes = byteSizeMap[accessor.componentType];
            const elementSize = sizeMap[accessor.type] ?? 1;
            const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
            const stride = bufferView.byteStride ?? (componentBytes * elementSize);
            const tightStride = componentBytes * elementSize;

            // If tightly packed, read directly
            if (stride === tightStride) {
                const data = new TypedArray(buffer, baseOffset, accessor.count * elementSize);
                return { data, count: accessor.count, elementSize };
            }

            // Strided: de-interleave into a tightly packed array
            const out = new TypedArray(accessor.count * elementSize);
            const src = new Uint8Array(buffer);
            const dst = new Uint8Array(out.buffer);
            for (let i = 0; i < accessor.count; i++) {
                const srcOff = baseOffset + i * stride;
                const dstOff = i * tightStride;
                for (let b = 0; b < tightStride; b++) {
                    dst[dstOff + b] = src[srcOff + b];
                }
            }

            return { data: out, count: accessor.count, elementSize };
        };

        // Pre-load all unique textures (cache by image index to avoid duplicates)
        const textureCache = new Map<number, ImageBitmap>();
        const loadTexture = async (imageIndex: number): Promise<ImageBitmap | undefined> => {
            if (textureCache.has(imageIndex)) return textureCache.get(imageIndex)!;
            const image = gltf.images?.[imageIndex];
            if (!image) return undefined;

            let blob: Blob | undefined;
            if (image.bufferView !== undefined) {
                const bv = gltf.bufferViews[image.bufferView];
                const buf = buffers[bv.buffer];
                const data = new Uint8Array(buf, bv.byteOffset ?? 0, bv.byteLength);
                blob = new Blob([data], { type: image.mimeType ?? 'image/png' });
            } else if (image.uri) {
                const imgUrl = image.uri.startsWith('data:') ? image.uri : baseUrl + image.uri;
                blob = await (await fetch(imgUrl)).blob();
            }

            if (blob) {
                const bmp = await createImageBitmap(blob);
                textureCache.set(imageIndex, bmp);
                return bmp;
            }
            return undefined;
        };

        // Find the first mesh node (used for skin detection)
        const meshNodeIndex = gltf.nodes?.findIndex((n: any) => n.mesh !== undefined) ?? -1;

        // --- Detect skin and parse animation data ---
        const skinIndex = meshNodeIndex !== -1 ? gltf.nodes?.[meshNodeIndex]?.skin : undefined;
        let skinData: SkinData | null = null;
        let animClips: AnimationClipData[] = [];
        let skinnedModelSkinIndex = -1;

        if (skinIndex !== undefined && gltf.skins?.[skinIndex]) {
            skinData = parseSkin(gltf, skinIndex, getAccessorData);
            animClips = parseAnimations(gltf, skinData, getAccessorData);

            // Filter animations if specified
            if (opts?.animations) {
                animClips = animClips.filter(clip => opts.animations.includes(clip.name));
            }

            // Register the skeletal animation controller
            const animation = new SkeletalAnimation(skinData, animClips, gltf.nodes);

            // Compute bounding radius from IBM translations (bind-pose joint positions)
            const ibm = skinData.inverseBindMatrices;
            let maxRadSq = 0;
            for (let j = 0; j < skinData.jointCount; j++) {
                // IBM translation column = -bindPosePosition (column 3: indices 12,13,14)
                const tx = ibm[j * 16 + 12], ty = ibm[j * 16 + 13], tz = ibm[j * 16 + 14];
                const rSq = tx * tx + ty * ty + tz * tz;
                if (rSq > maxRadSq) maxRadSq = rSq;
            }
            // Add 50% margin for animation movement
            const skinnedRadius = Math.sqrt(maxRadSq) * 1.5;

            skinnedModelSkinIndex = this.skinnedModels.length;
            this.skinnedModels.push({
                animation,
                jointCount: skinData.jointCount,
                boundingRadius: skinnedRadius,
            });

            // Pack animation data for GPU compute
            packSkinAndAnimations(this.packedAnimData, skinData, animClips, gltf.nodes);
            this.animComputeNeedsRebuild = true;
        }

        // --- Load all primitives from all meshes ---
        const handles: ModelHandle[] = [];

        // Collect all mesh node indices (nodes that have a mesh property)
        const meshNodeIndices: number[] = [];
        for (let i = 0; i < gltf.nodes.length; i++) {
            if (gltf.nodes[i].mesh !== undefined) meshNodeIndices.push(i);
        }
        // Fallback: if no mesh nodes found, just use meshes[0]
        const meshIndicesToLoad = meshNodeIndices.length > 0
            ? meshNodeIndices.map((ni: number) => gltf.nodes[ni].mesh as number)
            : [0];

        for (const meshIdx of meshIndicesToLoad) {
            const mesh = gltf.meshes[meshIdx];
            if (!mesh) continue;

            // Check if this mesh's node has a skin
            const meshNodeForThis = gltf.nodes.find((n: any) => n.mesh === meshIdx);
            const meshSkinIndex = meshNodeForThis?.skin;
            const isSkinned = skinData && meshSkinIndex !== undefined;

            // Get mesh node transform for this specific mesh node
            let thisMeshNodeMatrix: Float32Array | null = null;
            if (meshNodeForThis && !isSkinned) {
                if (meshNodeForThis.scale || meshNodeForThis.rotation || meshNodeForThis.translation || meshNodeForThis.matrix) {
                    thisMeshNodeMatrix = nodeToMat4(meshNodeForThis);
                }
            }

        for (const primitive of mesh.primitives) {
            // Positions (required)
            const posAccess = getAccessorData(primitive.attributes.POSITION);
            const positions = new Float32Array(posAccess.data as Float32Array);

            // Normals (optional)
            let normals: Float32Array | undefined;
            if (primitive.attributes.NORMAL !== undefined) {
                normals = new Float32Array(getAccessorData(primitive.attributes.NORMAL).data as Float32Array);
            }

            // UVs (optional)
            let uvs: Float32Array | undefined;
            if (primitive.attributes.TEXCOORD_0 !== undefined) {
                uvs = new Float32Array(getAccessorData(primitive.attributes.TEXCOORD_0).data as Float32Array);
            }

            // Indices (optional)
            let indices: Uint16Array | Uint32Array | undefined;
            if (primitive.indices !== undefined) {
                const idxAccess = getAccessorData(primitive.indices);
                indices = idxAccess.data.length > 65535
                    ? new Uint32Array(idxAccess.data)
                    : new Uint16Array(idxAccess.data);
            }

            // Apply mesh node transform (e.g. scale [-1,1,1] for X mirror) — non-skinned only
            if (thisMeshNodeMatrix && !isSkinned) {
                const meshNodeMatrix = thisMeshNodeMatrix;
                const mm = meshNodeMatrix;
                const vertexCount = positions.length / 3;
                for (let v = 0; v < vertexCount; v++) {
                    const o = v * 3;
                    const px = positions[o], py = positions[o + 1], pz = positions[o + 2];
                    positions[o]     = mm[0] * px + mm[4] * py + mm[8]  * pz + mm[12];
                    positions[o + 1] = mm[1] * px + mm[5] * py + mm[9]  * pz + mm[13];
                    positions[o + 2] = mm[2] * px + mm[6] * py + mm[10] * pz + mm[14];

                    if (normals) {
                        const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
                        const tnx = mm[0] * nx + mm[4] * ny + mm[8]  * nz;
                        const tny = mm[1] * nx + mm[5] * ny + mm[9]  * nz;
                        const tnz = mm[2] * nx + mm[6] * ny + mm[10] * nz;
                        const len = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
                        if (len > 0) {
                            normals[o] = tnx / len;
                            normals[o + 1] = tny / len;
                            normals[o + 2] = tnz / len;
                        }
                    }
                }
            }

            // Texture (optional)
            let texture: ImageBitmap | undefined;
            if (primitive.material !== undefined) {
                const material = gltf.materials?.[primitive.material];
                const texIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
                if (texIndex !== undefined && gltf.textures?.[texIndex]) {
                    texture = await loadTexture(gltf.textures[texIndex].source);
                }
            }

            // Skinned vs non-skinned model loading
            if (isSkinned) {
                const skinAttrs = parsePrimitiveSkinAttributes(primitive, getAccessorData);
                if (skinAttrs) {
                    handles.push(this.loadSkinnedModel(
                        { positions, normals, uvs, indices, texture },
                        skinAttrs,
                        skinnedModelSkinIndex,
                    ));
                    continue;
                }
            }

            handles.push(this.loadModel({ positions, normals, uvs, indices, texture }));
        }
        } // end for meshIdx

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
            src: url,
        };
    }

    /**
     * Add an instance. For skinned models, pass `linkedTo` to share bone matrices
     * with another instance (e.g., when spawning all parts of a character).
     */
    addInstance(opts: MeshInstanceOptions): InstanceHandle {
        const modelOrGltf = opts.model;

        // GltfModel: spawn all parts as a linked group
        if ('parts' in modelOrGltf) {
            return this.addGltfInstance(opts, modelOrGltf as GltfModel);
        }

        const modelHandle = modelOrGltf as ModelHandle;
        const model = this.models[modelHandle.id];

        // Route skinned models to the skinned instance path
        if (model?.skinned) {
            return this.addSkinnedInstance(opts, modelHandle, model.skinIndex);
        }

        const slot = this.freeList.allocate();
        if (slot === -1) throw new Error(`Max instances (${this.maxModels}) reached`);

        const dynBase = slot * DYNAMIC_MESH_FLOATS;
        const statBase = slot * STATIC_MESH_FLOATS;

        const x = opts.x ?? 0, y = opts.y ?? 0, z = opts.z ?? 0;
        this.dynamicData[dynBase + DYN_PREV_PX] = x;
        this.dynamicData[dynBase + DYN_PREV_PY] = y;
        this.dynamicData[dynBase + DYN_PREV_PZ] = z;
        this.dynamicData[dynBase + DYN_CURR_PX] = x;
        this.dynamicData[dynBase + DYN_CURR_PY] = y;
        this.dynamicData[dynBase + DYN_CURR_PZ] = z;

        const rx = opts.rotX ?? 0, ry = opts.rotY ?? 0, rz = opts.rotZ ?? 0;
        this.dynamicData[dynBase + DYN_PREV_RX] = rx;
        this.dynamicData[dynBase + DYN_PREV_RY] = ry;
        this.dynamicData[dynBase + DYN_PREV_RZ] = rz;
        this.dynamicData[dynBase + DYN_CURR_RX] = rx;
        this.dynamicData[dynBase + DYN_CURR_RY] = ry;
        this.dynamicData[dynBase + DYN_CURR_RZ] = rz;

        this.staticData[statBase + STAT_SX] = opts.scaleX ?? 1;
        this.staticData[statBase + STAT_SY] = opts.scaleY ?? 1;
        this.staticData[statBase + STAT_SZ] = opts.scaleZ ?? 1;

        const color = opts.color ?? [1, 1, 1];
        this.staticData[statBase + STAT_CR] = color[0];
        this.staticData[statBase + STAT_CG] = color[1];
        this.staticData[statBase + STAT_CB] = color[2];

        this.staticDirty = true;
        this.instanceModelIds[slot] = modelHandle.id;
        this.batcher.add(0, modelHandle.id, slot);

        const dynamicData = this.dynamicData;
        const staticData = this.staticData;

        return {
            skinned: false,
            setPosition(nx: number, ny: number, nz: number) {
                dynamicData[dynBase + DYN_CURR_PX] = nx;
                dynamicData[dynBase + DYN_CURR_PY] = ny;
                dynamicData[dynBase + DYN_CURR_PZ] = nz;
            },
            setRotation(nx: number, ny: number, nz: number) {
                dynamicData[dynBase + DYN_CURR_RX] = nx;
                dynamicData[dynBase + DYN_CURR_RY] = ny;
                dynamicData[dynBase + DYN_CURR_RZ] = nz;
            },
            setScale(nx: number, ny: number, nz: number) {
                staticData[statBase + STAT_SX] = nx;
                staticData[statBase + STAT_SY] = ny;
                staticData[statBase + STAT_SZ] = nz;
            },
        };
    }

    private addGltfInstance(opts: MeshInstanceOptions, gltf: GltfModel): InstanceHandle {
        const childHandles: MeshInstanceHandle[] = [];
        let firstSkinnedSlot: number | undefined;

        for (const part of gltf.parts) {
            const partOpts = { ...opts, model: part };
            const model = this.models[part.id];

            let handle: MeshInstanceHandle;
            if (model?.skinned) {
                handle = this.addSkinnedInstance(partOpts, part, model.skinIndex, firstSkinnedSlot);
                if (firstSkinnedSlot === undefined) firstSkinnedSlot = handle.slot;
            } else {
                // Re-use the single-part non-skinned path directly
                handle = this.addInstance(partOpts) as MeshInstanceHandle;
            }
            childHandles.push(handle);
        }

        // Find the first skinned handle for animation control
        const skinnedHandle = childHandles.find(h => h.skinned);

        return {
            skinned: gltf.skinned,
            setPosition(x: number, y: number, z: number) {
                for (const h of childHandles) h.setPosition(x, y, z);
            },
            setRotation(x: number, y: number, z: number) {
                for (const h of childHandles) h.setRotation(x, y, z);
            },
            setScale(x: number, y: number, z: number) {
                for (const h of childHandles) h.setScale(x, y, z);
            },
            play: skinnedHandle?.play ? (name: string, opts?: PlayOptions) => {
                skinnedHandle.play!(name, opts);
            } : undefined,
            stop: skinnedHandle?.stop ? () => {
                skinnedHandle.stop!();
            } : undefined,
        };
    }

    private addSkinnedInstance(opts: MeshInstanceOptions, modelHandle: ModelHandle, skinIndex: number, linkedSlot?: number): MeshInstanceHandle {
        const slot = this.skinnedFreeList.allocate();
        if (slot === -1) throw new Error(`Max skinned instances (${this.maxSkinnedInstances}) reached`);

        const skinModel = this.skinnedModels[skinIndex];
        const jointCount = skinModel.jointCount;

        let boneOffset: number;
        let animState: SkeletalAnimState | null;

        if (linkedSlot !== undefined) {
            // Share bone offset and animation state with linked slot
            boneOffset = this.skinnedInstanceBoneOffsets[linkedSlot];
            animState = this.skinnedAnimStates[linkedSlot];
        } else {
            // Allocate new bone offset block
            // Allocate 2x: [world matrices | final bone matrices]
            // boneOffset points to the final section (vertex shader reads from here)
            boneOffset = this.nextBoneOffset + jointCount;
            this.nextBoneOffset += jointCount * 2;

            // Write rest-pose bone matrices directly into boneMatrixData (zero-alloc)
            skinModel.animation.computeRestPose(this.boneMatrixData, boneOffset * 16);
            this.boneMatrixDirty = true;

            // Create animation state (auto-plays first clip if available)
            animState = skinModel.animation.clipCount > 0
                ? skinModel.animation.createState(0, 1, true)
                : null;
        }

        this.skinnedInstanceBoneOffsets[slot] = boneOffset;
        this.skinnedAnimStates[slot] = animState;

        const dynBase = slot * DYNAMIC_MESH_FLOATS;
        const statBase = slot * SKINNED_STATIC_MESH_FLOATS;

        const x = opts.x ?? 0, y = opts.y ?? 0, z = opts.z ?? 0;
        this.skinnedDynamicData[dynBase + DYN_PREV_PX] = x;
        this.skinnedDynamicData[dynBase + DYN_PREV_PY] = y;
        this.skinnedDynamicData[dynBase + DYN_PREV_PZ] = z;
        this.skinnedDynamicData[dynBase + DYN_CURR_PX] = x;
        this.skinnedDynamicData[dynBase + DYN_CURR_PY] = y;
        this.skinnedDynamicData[dynBase + DYN_CURR_PZ] = z;

        const rx = opts.rotX ?? 0, ry = opts.rotY ?? 0, rz = opts.rotZ ?? 0;
        this.skinnedDynamicData[dynBase + DYN_PREV_RX] = rx;
        this.skinnedDynamicData[dynBase + DYN_PREV_RY] = ry;
        this.skinnedDynamicData[dynBase + DYN_PREV_RZ] = rz;
        this.skinnedDynamicData[dynBase + DYN_CURR_RX] = rx;
        this.skinnedDynamicData[dynBase + DYN_CURR_RY] = ry;
        this.skinnedDynamicData[dynBase + DYN_CURR_RZ] = rz;

        this.skinnedStaticData[statBase + SSTAT_SX] = opts.scaleX ?? 1;
        this.skinnedStaticData[statBase + SSTAT_SY] = opts.scaleY ?? 1;
        this.skinnedStaticData[statBase + SSTAT_SZ] = opts.scaleZ ?? 1;

        const color = opts.color ?? [1, 1, 1];
        this.skinnedStaticData[statBase + SSTAT_CR] = color[0];
        this.skinnedStaticData[statBase + SSTAT_CG] = color[1];
        this.skinnedStaticData[statBase + SSTAT_CB] = color[2];

        // boneOffset is u32, but stored in a Float32Array — use DataView for correct bit pattern
        new DataView(this.skinnedStaticData.buffer).setUint32(
            (statBase + SSTAT_BONE_OFFSET) * 4, boneOffset, true
        );

        this.skinnedStaticDirty = true;
        this.skinnedInstanceModelIds[slot] = modelHandle.id;
        this.skinnedBatcher.add(0, modelHandle.id, slot);

        const dynamicData = this.skinnedDynamicData;
        const staticData = this.skinnedStaticData;
        const animStates = this.skinnedAnimStates;
        const animation = skinModel.animation;

        return {
            slot,
            modelId: modelHandle.id,
            skinned: true,
            setPosition(nx: number, ny: number, nz: number) {
                dynamicData[dynBase + DYN_CURR_PX] = nx;
                dynamicData[dynBase + DYN_CURR_PY] = ny;
                dynamicData[dynBase + DYN_CURR_PZ] = nz;
            },
            setRotation(nx: number, ny: number, nz: number) {
                dynamicData[dynBase + DYN_CURR_RX] = nx;
                dynamicData[dynBase + DYN_CURR_RY] = ny;
                dynamicData[dynBase + DYN_CURR_RZ] = nz;
            },
            setScale(nx: number, ny: number, nz: number) {
                staticData[statBase + SSTAT_SX] = nx;
                staticData[statBase + SSTAT_SY] = ny;
                staticData[statBase + SSTAT_SZ] = nz;
            },
            play(name: string, opts?: PlayOptions) {
                const state = animStates[slot];
                if (state) animation.play(state, name, opts);
            },
            stop() {
                const state = animStates[slot];
                if (state) animation.stop(state);
            },
        };
    }

    /**
     * Update skeletal animations for all skinned instances. Call once per tick.
     */
    // Pre-allocated dedup tracker for updateAnimations — indexed by bone offset, not slot (zero-GC)
    private updatedBoneOffsets = new Uint8Array(DEFAULT_MAX_TOTAL_BONES);

    private updateAnimations(deltaTime: number): void {
        // Rebuild GPU compute kernel if new skinned models were loaded
        if (this.animComputeNeedsRebuild && this.packedAnimData.clips.length > 0) {
            this.animComputeKernel?.destroy();
            const { kernel, packedBuffers } = buildAnimationKernel(
                this.root, this.packedAnimData, this.maxSkinnedInstances, this.maxTotalBones,
            );
            this.animComputeKernel = kernel;
            this.animClipTableOffset = packedBuffers.clipTableOffset;
            this.animChannelTableOffset = packedBuffers.channelTableOffset;
            this.animJointLookupOffset = packedBuffers.jointLookupOffset;

            // Get bone matrix buffer from the kernel and wire it into the skinned render bind group
            const rawBoneBuffer = this.root.unwrap(kernel.getBuffer('boneMatrices')) as GPUBuffer;
            this.rawBoneMatrixBuffer = rawBoneBuffer;

            const rawSkinnedBGL = this.root.unwrap(this.skinnedMeshLayout);
            this.rawSkinnedBindGroup = this.device.createBindGroup({
                layout: rawSkinnedBGL as GPUBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.rawUniformBuffer } },
                    { binding: 1, resource: { buffer: this.rawSkinnedDynamicBuffer } },
                    { binding: 2, resource: { buffer: this.rawSkinnedStaticBuffer } },
                    { binding: 3, resource: { buffer: this.rawSkinnedSlotIndexBuffer } },
                    { binding: 4, resource: { buffer: rawBoneBuffer } },
                ],
            });
            this.animComputeNeedsRebuild = false;
        }

        // Advance time on CPU + pack instance states for GPU
        this.updatedBoneOffsets.fill(0);
        let count = 0;
        const dv = this.gpuInstDV;

        for (let slot = 0; slot < this.maxSkinnedInstances; slot++) {
            const animState = this.skinnedAnimStates[slot];
            if (!animState) continue;

            const boneOffset = this.skinnedInstanceBoneOffsets[slot];
            if (this.updatedBoneOffsets[boneOffset]) continue;
            this.updatedBoneOffsets[boneOffset] = 1;

            // Advance time on CPU (with looping)
            if (animState.playing) {
                const modelId = this.skinnedInstanceModelIds[slot];
                const model = this.models[modelId];
                const skinModel = model?.skinIndex >= 0 ? this.skinnedModels[model.skinIndex] : null;
                if (skinModel) {
                    animState.time += deltaTime * animState.speed;
                    const clip = skinModel.animation.getClip(animState.clipId);
                    if (clip && clip.duration > 0 && animState.time >= clip.duration) {
                        animState.onEnd();
                        if (animState.loop) {
                            animState.time %= clip.duration;
                        } else {
                            animState.time = clip.duration - 0.0001;
                            animState.playing = false;
                        }
                    }
                }
            }

            // Advance crossfade
            if (animState.prevClipId !== -1 && animState.blendDuration > 0) {
                animState.blendWeight += deltaTime / animState.blendDuration;
                if (animState.blendWeight >= 1) {
                    animState.blendWeight = 1;
                    animState.prevClipId = -1;
                    animState.blendDuration = 0;
                }
                animState.prevTime += deltaTime * animState.prevSpeed;
            }

            const modelId = this.skinnedInstanceModelIds[slot];
            const model = this.models[modelId];
            const skinIdx = model?.skinIndex ?? 0;

            const off = count * 32;
            dv.setInt32(off, animState.clipId, true);
            dv.setFloat32(off + 4, animState.time, true);
            dv.setUint32(off + 8, skinIdx, true);
            dv.setUint32(off + 12, boneOffset, true);
            dv.setInt32(off + 16, animState.prevClipId, true);
            dv.setFloat32(off + 20, animState.prevTime, true);
            dv.setFloat32(off + 24, animState.blendWeight, true);
            dv.setFloat32(off + 28, 0, true);
            count++;
        }

        if (count > 0) {
            if (this.animComputeKernel) {
                // Write uniforms (offsets are static, instanceCount changes per frame)
                this.animComputeKernel.write('uniforms', {
                    instanceCount: count,
                    clipTableOffset: this.animClipTableOffset,
                    channelTableOffset: this.animChannelTableOffset,
                    jointLookupOffset: this.animJointLookupOffset,
                });

                // Write instance states via raw buffer (TypeGPU write expects full array)
                const instBuf = this.animComputeKernel.getBuffer('instances');
                const rawInstBuf = this.root.unwrap(instBuf) as GPUBuffer;
                this.device.queue.writeBuffer(rawInstBuf, 0, this.gpuInstData.buffer, 0, count * 32);

                // Dispatch
                this.animComputeKernel.dispatch(count);
            } else {
                // CPU fallback
                this.updatedBoneOffsets.fill(0);
                for (let slot = 0; slot < this.maxSkinnedInstances; slot++) {
                    const animState = this.skinnedAnimStates[slot];
                    if (!animState || !animState.playing) continue;
                    const boneOffset = this.skinnedInstanceBoneOffsets[slot];
                    if (this.updatedBoneOffsets[boneOffset]) continue;
                    this.updatedBoneOffsets[boneOffset] = 1;
                    const modelId = this.skinnedInstanceModelIds[slot];
                    const model = this.models[modelId];
                    if (!model || model.skinIndex === -1) continue;
                    const skinModel = this.skinnedModels[model.skinIndex];
                    skinModel.animation.update(animState, deltaTime, this.boneMatrixData, boneOffset * 16);
                }
                this.device.queue.writeBuffer(this.rawBoneMatrixBuffer, 0, this.boneMatrixData as GPUAllowSharedBufferSource);
            }
        }
    }

    removeInstance(handle: MeshInstanceHandle): void {
        this.batcher.remove(0, handle.modelId, handle.slot);
        this.freeList.free(handle.slot);

        const dynBase = handle.slot * DYNAMIC_MESH_FLOATS;
        const statBase = handle.slot * STATIC_MESH_FLOATS;
        this.dynamicData.fill(0, dynBase, dynBase + DYNAMIC_MESH_FLOATS);
        this.staticData.fill(0, statBase, statBase + STATIC_MESH_FLOATS);
        this.staticDirty = true;
    }

    storePreviousState(): void {
        this.camera.storePrevious();

        // Non-skinned instances
        const dyn = this.dynamicData;
        this.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const base = instances[i] * DYNAMIC_MESH_FLOATS;
                dyn[base + DYN_PREV_PX] = dyn[base + DYN_CURR_PX];
                dyn[base + DYN_PREV_PY] = dyn[base + DYN_CURR_PY];
                dyn[base + DYN_PREV_PZ] = dyn[base + DYN_CURR_PZ];
                dyn[base + DYN_PREV_RX] = dyn[base + DYN_CURR_RX];
                dyn[base + DYN_PREV_RY] = dyn[base + DYN_CURR_RY];
                dyn[base + DYN_PREV_RZ] = dyn[base + DYN_CURR_RZ];
            }
        });

        // Skinned instances
        const sDyn = this.skinnedDynamicData;
        this.skinnedBatcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const base = instances[i] * DYNAMIC_MESH_FLOATS;
                sDyn[base + DYN_PREV_PX] = sDyn[base + DYN_CURR_PX];
                sDyn[base + DYN_PREV_PY] = sDyn[base + DYN_CURR_PY];
                sDyn[base + DYN_PREV_PZ] = sDyn[base + DYN_CURR_PZ];
                sDyn[base + DYN_PREV_RX] = sDyn[base + DYN_CURR_RX];
                sDyn[base + DYN_PREV_RY] = sDyn[base + DYN_CURR_RY];
                sDyn[base + DYN_PREV_RZ] = sDyn[base + DYN_CURR_RZ];
            }
        });
    }

    render(alpha: number): void {
        if (!this._initialized) return;

        // Advance skeletal animations at render framerate
        const now = performance.now();
        if (this.lastRenderTime > 0) {
            const deltaTime = (now - this.lastRenderTime) / 1000;
            this.updateAnimations(deltaTime);
        }
        this.lastRenderTime = now;

        this.camera.interpolate(alpha);

        // Upload dynamic data
        this.device.queue.writeBuffer(
            this.rawDynamicBuffer, 0,
            this.dynamicData.buffer, this.dynamicData.byteOffset, this.dynamicData.byteLength,
        );

        // Upload static data
        if (this.staticDirty) {
            this.device.queue.writeBuffer(
                this.rawStaticBuffer, 0,
                this.staticData.buffer, this.staticData.byteOffset, this.staticData.byteLength,
            );
            this.staticDirty = false;
        }

        // Upload uniforms: VP matrix + alpha + light dir
        const vpMatrix = this.camera.getViewProjectionMatrix();
        this.uniformData.set(vpMatrix, 0);
        this.uniformData[16] = alpha;
        this.uniformData[17] = 0.3;
        this.uniformData[18] = 0.8;
        this.uniformData[19] = 0.5;
        this.device.queue.writeBuffer(
            this.rawUniformBuffer, 0,
            this.uniformData.buffer, this.uniformData.byteOffset,
            80,
        );

        // Extract frustum planes from VP matrix for culling
        this.extractFrustumPlanes(vpMatrix);

        // Pack slot indices per model, with frustum culling
        let indexOffset = 0;
        const batchOffsets: { modelId: number; offset: number; count: number }[] = [];
        const dyn = this.dynamicData;
        const stat = this.staticData;

        this.batcher.each((modelId, instances, count) => {
            const model = this.models[modelId];
            if (!model) return;
            const baseRadius = model.boundingRadius;
            const batchStart = indexOffset;

            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * STATIC_MESH_FLOATS;

                // Use current position for culling
                const cx = dyn[base + DYN_CURR_PX];
                const cy = dyn[base + DYN_CURR_PY];
                const cz = dyn[base + DYN_CURR_PZ];

                // Scale the bounding radius by max scale axis
                const sx = stat[sBase + STAT_SX];
                const sy = stat[sBase + STAT_SY];
                const sz = stat[sBase + STAT_SZ];
                const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                const radius = baseRadius * maxScale;

                // Frustum sphere test
                if (this.isInFrustum(cx, cy, cz, radius)) {
                    this.slotIndexData[indexOffset++] = slot;
                }
            }

            const visibleCount = indexOffset - batchStart;
            if (visibleCount > 0) {
                batchOffsets.push({ modelId, offset: batchStart, count: visibleCount });
            }
        });

        if (indexOffset > 0) {
            this.device.queue.writeBuffer(
                this.rawSlotIndexBuffer, 0,
                this.slotIndexData.buffer, this.slotIndexData.byteOffset,
                indexOffset * 4,
            );
        }

        // --- Upload skinned buffers ---
        this.device.queue.writeBuffer(
            this.rawSkinnedDynamicBuffer, 0,
            this.skinnedDynamicData.buffer, this.skinnedDynamicData.byteOffset, this.skinnedDynamicData.byteLength,
        );

        if (this.skinnedStaticDirty) {
            this.device.queue.writeBuffer(
                this.rawSkinnedStaticBuffer, 0,
                this.skinnedStaticData.buffer, this.skinnedStaticData.byteOffset, this.skinnedStaticData.byteLength,
            );
            this.skinnedStaticDirty = false;
        }

        // Upload bone matrices from CPU only if GPU compute is not active
        if (this.boneMatrixDirty) {
            this.device.queue.writeBuffer(
                this.rawBoneMatrixBuffer, 0,
                this.boneMatrixData.buffer, this.boneMatrixData.byteOffset, this.boneMatrixData.byteLength,
            );
            this.boneMatrixDirty = false;
        }

        // Pack skinned slot indices
        let skinnedIndexOffset = 0;
        const skinnedBatchOffsets: { modelId: number; offset: number; count: number }[] = [];
        const sDyn = this.skinnedDynamicData;
        const sStat = this.skinnedStaticData;

        this.skinnedBatcher.each((modelId, instances, count) => {
            const model = this.models[modelId];
            if (!model) return;
            const batchStart = skinnedIndexOffset;

            // Frustum cull skinned instances using per-skin bounding radius
            const skinModel = model.skinIndex >= 0 ? this.skinnedModels[model.skinIndex] : null;
            const baseRadius = skinModel?.boundingRadius ?? 10;

            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * SKINNED_STATIC_MESH_FLOATS;

                const cx = sDyn[base + DYN_CURR_PX];
                const cy = sDyn[base + DYN_CURR_PY];
                const cz = sDyn[base + DYN_CURR_PZ];

                // Scale the bounding radius by instance scale
                const sx = sStat[sBase + SSTAT_SX];
                const sy = sStat[sBase + SSTAT_SY];
                const sz = sStat[sBase + SSTAT_SZ];
                const maxScale = Math.abs(sx) > Math.abs(sy) ? (Math.abs(sx) > Math.abs(sz) ? Math.abs(sx) : Math.abs(sz)) : (Math.abs(sy) > Math.abs(sz) ? Math.abs(sy) : Math.abs(sz));
                const radius = baseRadius * maxScale;

                if (this.isInFrustum(cx, cy, cz, radius)) {
                    this.skinnedSlotIndexData[skinnedIndexOffset++] = slot;
                }
            }

            const visibleCount = skinnedIndexOffset - batchStart;
            if (visibleCount > 0) {
                skinnedBatchOffsets.push({ modelId, offset: batchStart, count: visibleCount });
            }
        });

        if (skinnedIndexOffset > 0) {
            this.device.queue.writeBuffer(
                this.rawSkinnedSlotIndexBuffer, 0,
                this.skinnedSlotIndexData.buffer, this.skinnedSlotIndexData.byteOffset,
                skinnedIndexOffset * 4,
            );
        }

        // Compute + render in same command encoder (single submission)
        const textureView = this.context.getCurrentTexture().createView();
        const encoder = this.device.createCommandEncoder();

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: {
                    r: this._clearColor[0], g: this._clearColor[1],
                    b: this._clearColor[2], a: this._clearColor[3],
                },
            }],
            depthStencilAttachment: {
                view: this.depthTexture.createView(),
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 1.0,
            },
        });

        // --- Draw non-skinned models ---
        let currentPipeline: GPURenderPipeline | null = null;

        for (const batch of batchOffsets) {
            const model = this.models[batch.modelId];
            if (!model) continue;

            const pipeline = model.hasTexture ? this.rawTexturedPipeline : this.rawPipeline;
            if (pipeline !== currentPipeline) {
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.rawBindGroup);
                currentPipeline = pipeline;
            }

            if (model.hasTexture && model.textureBindGroup) {
                pass.setBindGroup(1, model.textureBindGroup);
            }

            pass.setVertexBuffer(0, model.rawVertexBuffer);

            if (model.rawIndexBuffer) {
                pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
            } else {
                pass.draw(model.vertexCount, batch.count, 0, batch.offset);
            }
        }

        // --- Draw skinned models ---
        currentPipeline = null;

        for (const batch of skinnedBatchOffsets) {
            const model = this.models[batch.modelId];
            if (!model) continue;

            const pipeline = model.hasTexture ? this.rawSkinnedTexturedPipeline : this.rawSkinnedPipeline;
            if (pipeline !== currentPipeline) {
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.rawSkinnedBindGroup);
                currentPipeline = pipeline;
            }

            if (model.hasTexture && model.textureBindGroup) {
                pass.setBindGroup(1, model.textureBindGroup);
            }

            pass.setVertexBuffer(0, model.rawVertexBuffer);

            if (model.rawIndexBuffer) {
                pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
            } else {
                pass.draw(model.vertexCount, batch.count, 0, batch.offset);
            }
        }

        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Extract 6 frustum planes from a column-major VP matrix.
     * Each plane is [a, b, c, d] where ax + by + cz + d >= 0 means inside.
     */
    private extractFrustumPlanes(vp: Float32Array): void {
        const p = this.frustumPlanes;
        // Left:   row3 + row0
        p[0]  = vp[3] + vp[0];  p[1]  = vp[7] + vp[4];  p[2]  = vp[11] + vp[8];  p[3]  = vp[15] + vp[12];
        // Right:  row3 - row0
        p[4]  = vp[3] - vp[0];  p[5]  = vp[7] - vp[4];  p[6]  = vp[11] - vp[8];  p[7]  = vp[15] - vp[12];
        // Bottom: row3 + row1
        p[8]  = vp[3] + vp[1];  p[9]  = vp[7] + vp[5];  p[10] = vp[11] + vp[9];  p[11] = vp[15] + vp[13];
        // Top:    row3 - row1
        p[12] = vp[3] - vp[1];  p[13] = vp[7] - vp[5];  p[14] = vp[11] - vp[9];  p[15] = vp[15] - vp[13];
        // Near:   row3 + row2
        p[16] = vp[3] + vp[2];  p[17] = vp[7] + vp[6];  p[18] = vp[11] + vp[10]; p[19] = vp[15] + vp[14];
        // Far:    row3 - row2
        p[20] = vp[3] - vp[2];  p[21] = vp[7] - vp[6];  p[22] = vp[11] - vp[10]; p[23] = vp[15] - vp[14];

        // Normalize each plane
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const len = Math.sqrt(p[o] * p[o] + p[o + 1] * p[o + 1] + p[o + 2] * p[o + 2]);
            if (len > 0) {
                const inv = 1 / len;
                p[o] *= inv; p[o + 1] *= inv; p[o + 2] *= inv; p[o + 3] *= inv;
            }
        }
    }

    /**
     * Test if a bounding sphere is inside or intersects the frustum.
     * Returns true if visible (should be drawn).
     */
    private isInFrustum(x: number, y: number, z: number, radius: number): boolean {
        const p = this.frustumPlanes;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const dist = p[o] * x + p[o + 1] * y + p[o + 2] * z + p[o + 3];
            if (dist < -radius) return false; // entirely outside this plane
        }
        return true;
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.resizeCallbacks.length = 0;
        this.dynamicBuffer?.destroy();
        this.staticBuffer?.destroy();
        this.uniformBuffer?.destroy();
        this.slotIndexBuffer?.destroy();
        this.depthTexture?.destroy();
        for (const m of this.models) {
            m.rawVertexBuffer.destroy();
            m.rawIndexBuffer?.destroy();
        }
        this.models.length = 0;
        this.root?.destroy();
    }
}

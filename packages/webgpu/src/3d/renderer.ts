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
    DynamicMesh,
    StaticMesh,
    MeshUniforms,
} from '../core/types';
import { Camera3D } from '../camera/camera-3d';
import {
    createMeshLayout,
    createMeshVertex,
    createMeshFragment,
    type MeshDataLayout,
} from './shader';

// --- Dynamic offset constants ---
const DYN_PREV_PX = 0, DYN_PREV_PY = 1, DYN_PREV_PZ = 2;
const DYN_CURR_PX = 3, DYN_CURR_PY = 4, DYN_CURR_PZ = 5;
const DYN_PREV_RX = 6, DYN_PREV_RY = 7, DYN_PREV_RZ = 8;
const DYN_CURR_RX = 9, DYN_CURR_RY = 10, DYN_CURR_RZ = 11;

// --- Static offset constants ---
const STAT_SX = 0, STAT_SY = 1, STAT_SZ = 2;
const STAT_CR = 3, STAT_CG = 4, STAT_CB = 5;

export interface ModelHandle {
    readonly id: number;
    readonly vertexCount: number;
    readonly indexCount: number;
}

export interface MeshInstanceHandle {
    readonly slot: number;
    readonly modelId: number;
    setPosition(x: number, y: number, z: number): void;
    setRotation(x: number, y: number, z: number): void;
    setScale(x: number, y: number, z: number): void;
}

export interface MeshInstanceOptions {
    model: ModelHandle;
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

    // Models (vertex + index buffers)
    private models: {
        rawVertexBuffer: GPUBuffer;
        rawIndexBuffer: GPUBuffer | null;
        vertexCount: number;
        indexCount: number;
        indexFormat: GPUIndexFormat;
        boundingRadius: number;
    }[] = [];
    private nextModelId = 0;

    // Frustum planes (6 planes × 4 floats each), extracted from VP matrix
    private frustumPlanes = new Float32Array(24);

    readonly camera: Camera3D;
    private uniformData = new Float32Array(24); // mat4x4 (16) + alpha (1) + lightDir (3) + padding (4)

    constructor(canvas: HTMLCanvasElement, options: Renderer3DOptions) {
        super(canvas, options);
        this.camera = new Camera3D();
        this.freeList = new FreeList(options.maxModels);
        this.batcher = new SparseBatcher(options.maxModels);
        this.dynamicData = new Float32Array(options.maxModels * DYNAMIC_MESH_FLOATS);
        this.staticData = new Float32Array(options.maxModels * STATIC_MESH_FLOATS);
        this.slotIndexData = new Uint32Array(options.maxModels);
        this.instanceModelIds = new Uint8Array(options.maxModels);
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

        // TypeGPU layout + shaders
        this.meshLayout = createMeshLayout(this.maxModels);
        const vertex = createMeshVertex(this.meshLayout);
        const fragment = createMeshFragment(this.meshLayout);

        // Resolve WGSL from TypeGPU shaders
        const { code: wgslCode, usedBindGroupLayouts } = tgpu.resolveWithContext(
            [vertex, fragment],
        );
        const shaderModule = this.device.createShaderModule({ code: wgslCode });

        // Get the raw bind group layout from TypeGPU
        const rawBGL = this.root.unwrap(this.meshLayout);

        // Create pipeline with raw device (we need manual vertex buffer layout)
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [rawBGL],
        });

        this.rawPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                buffers: [{
                    // Interleaved: position(3f) + normal(3f) = 24 bytes
                    arrayStride: 24,
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
                        { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                    ],
                }],
            },
            fragment: {
                module: shaderModule,
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
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
     * Register a model (vertex + index data). Returns a handle for addInstance().
     */
    loadModel(positions: Float32Array, normals: Float32Array, indices?: Uint16Array | Uint32Array): ModelHandle {
        // Compute bounding radius (max distance from origin)
        const vertexCount = positions.length / 3;
        let maxRadiusSq = 0;
        for (let i = 0; i < vertexCount; i++) {
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
            const rSq = px * px + py * py + pz * pz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        const boundingRadius = Math.sqrt(maxRadiusSq);

        // Interleave position + normal into a single buffer
        const interleaved = new Float32Array(vertexCount * 6);
        for (let i = 0; i < vertexCount; i++) {
            interleaved[i * 6 + 0] = positions[i * 3 + 0];
            interleaved[i * 6 + 1] = positions[i * 3 + 1];
            interleaved[i * 6 + 2] = positions[i * 3 + 2];
            interleaved[i * 6 + 3] = normals[i * 3 + 0];
            interleaved[i * 6 + 4] = normals[i * 3 + 1];
            interleaved[i * 6 + 5] = normals[i * 3 + 2];
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
            indexBuffer = this.device.createBuffer({
                size: indices.byteLength,
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

        const id = this.nextModelId++;
        this.models[id] = {
            rawVertexBuffer: vertexBuffer,
            rawIndexBuffer: indexBuffer,
            vertexCount,
            indexCount,
            indexFormat: indices instanceof Uint32Array ? 'uint32' as const : 'uint16' as const,
            boundingRadius,
        };

        return { id, vertexCount, indexCount };
    }

    /**
     * Load a GLTF model from a URL. Parses the first mesh's positions, normals, and indices.
     */
    async loadGltf(url: string): Promise<ModelHandle> {
        const response = await fetch(url);
        const gltf = await response.json();
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

        if (!gltf.meshes?.length) throw new Error(`No meshes found in ${url}`);

        const mesh = gltf.meshes[0];
        const primitive = mesh.primitives[0];

        // Load binary buffers
        const buffers = await Promise.all(
            gltf.buffers.map(async (buf: any) => {
                const r = await fetch(baseUrl + buf.uri);
                return r.arrayBuffer();
            }),
        );

        // Helper: extract typed array from accessor
        const getAccessorData = (accessorIndex: number): { data: Float32Array | Uint16Array | Uint32Array; count: number; elementSize: number } => {
            const accessor = gltf.accessors[accessorIndex];
            const bufferView = gltf.bufferViews[accessor.bufferView];
            const buffer = buffers[bufferView.buffer];

            const typeMap: Record<number, any> = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array };
            const sizeMap: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

            const TypedArray = typeMap[accessor.componentType];
            const elementSize = sizeMap[accessor.type] ?? 1;
            const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
            const data = new TypedArray(buffer, byteOffset, accessor.count * elementSize);

            return { data, count: accessor.count, elementSize };
        };

        // Positions (required)
        const posAccess = getAccessorData(primitive.attributes.POSITION);
        const positions = new Float32Array(posAccess.data as Float32Array);

        // Normals (optional, default to up)
        let normals: Float32Array;
        if (primitive.attributes.NORMAL !== undefined) {
            const normAccess = getAccessorData(primitive.attributes.NORMAL);
            normals = new Float32Array(normAccess.data as Float32Array);
        } else {
            normals = new Float32Array(posAccess.count * 3);
            for (let i = 0; i < posAccess.count; i++) normals[i * 3 + 1] = 1; // default Y-up
        }

        // Indices (optional)
        let indices: Uint16Array | Uint32Array | undefined;
        if (primitive.indices !== undefined) {
            const idxAccess = getAccessorData(primitive.indices);
            indices = idxAccess.data.length > 65535
                ? new Uint32Array(idxAccess.data)
                : new Uint16Array(idxAccess.data);
        }

        return this.loadModel(positions, normals, indices);
    }

    addInstance(opts: MeshInstanceOptions): MeshInstanceHandle {
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
        this.instanceModelIds[slot] = opts.model.id;
        this.batcher.add(0, opts.model.id, slot);

        const dynamicData = this.dynamicData;
        const staticData = this.staticData;

        return {
            slot,
            modelId: opts.model.id,
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
        const dyn = this.dynamicData;
        this.batcher.each((_modelId, instances, count) => {
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
    }

    render(alpha: number): void {
        if (!this._initialized) return;

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

        // Render pass with depth
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

        pass.setPipeline(this.rawPipeline);
        pass.setBindGroup(0, this.rawBindGroup);

        // Draw per model type
        for (const batch of batchOffsets) {
            const model = this.models[batch.modelId];
            if (!model) continue;

            // Vertex buffer: interleaved pos(3f) + normal(3f) = 24 bytes stride
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
        this.root?.destroy();
    }
}

/**
 * The WebGPU device: a `GpuDevice` backed by a raw `GPUDevice`.
 *
 * Resources are addressed by opaque numeric handles so shared code never sees a
 * WebGPU type. Pipelines are built from the backend-agnostic descriptors in
 * `murow/gpu`. Command recording is buffered into one encoder per render pass.
 *
 * Construct with {@link webGpuDevice}.
 */
import type {
    BufferUsage,
    GpuBindGroupHandle,
    GpuBindGroupEntry,
    GpuBufferHandle,
    GpuBufferOptions,
    GpuDevice,
    GpuPipelineHandle,
    GpuTextureHandle,
    GpuTextureOptions,
    RenderPassOptions,
} from 'murow/gpu';
import { BindGroupLayout, GpuBackend, GpuContext, shaderSourceCode, type BindingEntry, type PipelineDescriptor } from 'murow/gpu';
import type { GpuStruct } from 'murow/gpu/schema';
import { wgslSpec } from './backend';

/** Whether buffer options carry an inline struct. */
function isStructBuffer(options: GpuBufferOptions): options is { struct: GpuStruct } {
    return 'struct' in options;
}

// Buffer/texture usage and shader stage bits, defined locally so tests need no GPU globals.
const BUF = { UNIFORM: 0x40, STORAGE: 0x80, VERTEX: 0x20, INDEX: 0x10, COPY_DST: 0x8 } as const;
const TEX = { SAMPLE: 0x4, STORAGE: 0x8, RENDER_TARGET: 0x10, COPY_SRC: 0x1, COPY_DST: 0x2 } as const;
const STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } as const;

const USAGE: Record<BufferUsage, number> = {
    uniform: BUF.UNIFORM,
    storage: BUF.STORAGE,
    vertex: BUF.VERTEX,
    index: BUF.INDEX,
};

const TEXTURE_USAGE: Record<GpuTextureOptions['usage'], number> = {
    sample: TEX.SAMPLE,
    storage: TEX.STORAGE,
    'render-target': TEX.RENDER_TARGET,
    'copy-src': TEX.COPY_SRC,
    'copy-dst': TEX.COPY_DST,
};

/** A recorded pipeline, render or compute. */
interface PipelineRecord {
    readonly render?: GPURenderPipeline;
    readonly compute?: GPUComputePipeline;
}

/** A WebGPU device wrapper. */
class WebGpuDevice implements GpuDevice {
    private readonly buffers: GPUBuffer[] = [];
    private readonly textures: GPUTexture[] = [];
    private readonly bindGroups: GPUBindGroup[] = [];
    private readonly layouts: GPUBindGroupLayout[] = [];
    private readonly pipelines: PipelineRecord[] = [];

    private encoder: GPUCommandEncoder | undefined;
    private pass: GPURenderPassEncoder | GPUPassEncoder | undefined;
    private computePass: GPUComputePassEncoder | undefined;
    private activePipeline: number | undefined;

    constructor(private readonly device: GPUDevice) {}

    createBuffer(options: GpuBufferOptions): GpuBufferHandle {
        const handle = this.buffers.length as GpuBufferHandle;
        const descriptor = isStructBuffer(options)
            ? { size: options.struct.size, usage: BUF.UNIFORM | BUF.COPY_DST }
            : { size: (options as { size: number }).size, usage: (USAGE[(options as { usage: BufferUsage }).usage] ?? 0) | BUF.COPY_DST };
        this.buffers.push(this.device.createBuffer(descriptor));
        return handle;
    }

    writeBuffer(buffer: GpuBufferHandle, offset: number, data: ArrayBufferView): void {
        this.device.queue.writeBuffer(this.bufferOf(buffer), offset, data as GPUAllowSharedBufferSource);
    }

    destroyBuffer(buffer: GpuBufferHandle): void {
        this.bufferOf(buffer).destroy();
    }

    createTexture(options: GpuTextureOptions): GpuTextureHandle {
        const handle = this.textures.length as GpuTextureHandle;
        this.textures.push(this.device.createTexture({
            size: [options.width, options.height],
            format: options.format as GPUTextureFormat,
            usage: TEXTURE_USAGE[options.usage],
        }));
        return handle;
    }

    createBindGroup(layout: BindGroupLayout, entries: readonly GpuBindGroupEntry[]): GpuBindGroupHandle {
        const handle = this.bindGroups.length as GpuBindGroupHandle;
        const rawLayout = this.layoutOf(layout);
        const gpuEntries: GPUBindGroupEntry[] = entries.map((entry) => {
            const slot = layout.get(entry.name);
            return { binding: slot?.binding ?? 0, resource: this.resolveResource(entry.resource) };
        });
        this.bindGroups.push(this.device.createBindGroup({ layout: rawLayout, entries: gpuEntries }));
        return handle;
    }

    createPipeline(descriptor: PipelineDescriptor): GpuPipelineHandle {
        const handle = this.pipelines.length as GpuPipelineHandle;
        this.pipelines.push(this.buildPipeline(descriptor));
        return handle;
    }

    beginRenderPass(options: RenderPassOptions): void {
        this.encoder = this.device.createCommandEncoder();
        const colorAttachments: GPURenderPassColorAttachment[] = (options.colorAttachments ?? []).map((attachment) => ({
            view: this.textureOf(attachment.texture).createView(),
            clearValue: attachment.clear ? ([...attachment.clear] as GPUColor) : undefined,
            loadOp: attachment.loadOp ?? (attachment.clear ? 'clear' : 'load'),
            storeOp: attachment.storeOp ?? 'store',
        }));
        const depthStencil = options.depthAttachment
            ? {
                view: this.textureOf(options.depthAttachment.texture).createView(),
                depthClearValue: options.depthAttachment.clear,
                depthLoadOp: options.depthAttachment.loadOp ?? (options.depthAttachment.clear !== undefined ? 'clear' : 'load'),
                depthStoreOp: options.depthAttachment.storeOp ?? 'store',
            } as GPURenderPassDepthStencilAttachment
            : undefined;
        const pass = this.encoder.beginRenderPass({ colorAttachments, depthStencilAttachment: depthStencil });
        this.pass = pass as unknown as GPUPassEncoder;
    }

    setPipeline(pipeline: GpuPipelineHandle): void {
        this.activePipeline = pipeline;
        const record = this.pipelines[pipeline]!;
        const pass = this.pass as GPURenderPassEncoder | undefined;
        if (record.render && pass) pass.setPipeline(record.render);
        else if (record.compute && this.computePass) this.computePass.setPipeline(record.compute);
    }

    setBindGroup(index: number, group: GpuBindGroupHandle): void {
        const raw = this.bindGroups[group]!;
        const pass = this.pass as GPURenderPassEncoder | undefined;
        if (pass) pass.setBindGroup(index, raw);
        else if (this.computePass) this.computePass.setBindGroup(index, raw);
    }

    draw(count: number, firstInstance: number, instanceCount: number): void {
        (this.pass as GPURenderPassEncoder | undefined)?.draw(count, instanceCount, firstInstance);
    }

    endRenderPass(): void {
        (this.pass as GPURenderPassEncoder | undefined)?.end();
        if (this.encoder) this.device.queue.submit([this.encoder.finish()]);
        this.pass = undefined;
        this.encoder = undefined;
    }

    dispatch(workgroupsX: number, workgroupsY: number, workgroupsZ: number): void {
        if (!this.computePass && this.encoder) {
            this.computePass = this.encoder.beginComputePass();
        }
        if (this.computePass) {
            if (this.activePipeline !== undefined) {
                const record = this.pipelines[this.activePipeline]!;
                if (record.compute) this.computePass.setPipeline(record.compute);
            }
            this.computePass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
        }
    }

    destroy(): void {
        for (const buffer of this.buffers) buffer.destroy();
    }

    private bufferOf(handle: GpuBufferHandle): GPUBuffer {
        return this.buffers[handle]!;
    }

    private textureOf(handle: GpuTextureHandle): GPUTexture {
        return this.textures[handle]!;
    }

    private resolveResource(resource: unknown): GPUBindingResource {
        if (typeof resource === 'number') return { buffer: this.buffers[resource]! };
        const value = resource as { buffer?: number; texture?: GpuTextureHandle; view?: GPUTextureView } | undefined;
        if (value && typeof value.buffer === 'number') return { buffer: this.buffers[value.buffer]! };
        if (value && typeof value.texture === 'number') return this.textures[value.texture]!.createView();
        if (value && value.view) return value.view;
        return resource as GPUBindingResource;
    }

    private layoutOf(layout: BindGroupLayout): GPUBindGroupLayout {
        const cached = this.layouts.indexOf(layout as unknown as GPUBindGroupLayout);
        if (cached >= 0) return this.layouts[cached]!;
        const entries: GPUBindGroupLayoutEntry[] = layout.entries.map((entry) => ({
            binding: entry.binding,
            visibility: visibilityBits(entry),
            ...entryToGpu(entry),
        }));
        const raw = this.device.createBindGroupLayout({ entries });
        this.layouts.push(raw);
        return raw;
    }

    private buildPipeline(descriptor: PipelineDescriptor): PipelineRecord {
        const code = shaderSourceCode(descriptor.vertex) ?? shaderSourceCode(descriptor.fragment);
        if (code === undefined) throw new Error('WebGpuDevice.createPipeline: a shader source string is required');
        const module = this.device.createShaderModule({ code, label: descriptor.label });
        const bindGroupLayouts = descriptor.bindGroupLayouts.map((layout) => this.layoutOf(layout));
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts });

        if (!descriptor.fragment) {
            return {
                compute: this.device.createComputePipeline({
                    layout: pipelineLayout,
                    compute: { module, entryPoint: descriptor.computeEntry },
                }),
            };
        }
        const targets: GPUColorTargetState[] | undefined = descriptor.colorFormat
            ? [{
                format: descriptor.colorFormat as GPUTextureFormat,
                blend: descriptor.renderState.blendState
                    ? toGpuBlend(descriptor.renderState.blendState)
                    : undefined,
                writeMask: descriptor.renderState.colorWrite,
            }]
            : [];
        return {
            render: this.device.createRenderPipeline({
                label: descriptor.label,
                layout: pipelineLayout,
                vertex: {
                    module,
                    entryPoint: descriptor.vertexEntry,
                    buffers: descriptor.vertexLayout.map((layout) => ({
                        arrayStride: layout.stride,
                        stepMode: layout.stepMode,
                        attributes: layout.attributes.map((attribute) => ({
                            shaderLocation: attribute.location,
                            offset: attribute.offset,
                            format: attribute.format as GPUVertexFormat,
                        })),
                    })),
                },
                fragment: {
                    module,
                    entryPoint: descriptor.fragmentEntry,
                    targets,
                },
                primitive: {
                    topology: descriptor.primitive.topology,
                    frontFace: descriptor.primitive.frontFace,
                    cullMode: descriptor.primitive.cull ?? 'none',
                },
                depthStencil: descriptor.depth
                    ? {
                        format: (descriptor.depthFormat ?? descriptor.depth.format ?? "depth24plus") as GPUTextureFormat,
                        depthWriteEnabled: descriptor.renderState.depthWrite,
                        depthCompare: descriptor.renderState.depthTest ? (descriptor.depth.depthCompare ?? 'less') : 'always',
                        depthBias: descriptor.renderState.depthBias,
                        depthBiasSlopeScale: descriptor.renderState.depthBiasSlopeScale,
                        depthBiasClamp: descriptor.renderState.depthBiasClamp,
                    }
                    : undefined,
                multisample: { count: descriptor.multisample.count },
            }),
        };
    }
}

/** Minimal shape of the two pass encoders, for shared calls. */
type GPUPassEncoder = GPURenderPassEncoder | GPUComputePassEncoder;

function visibilityBits(entry: BindingEntry): number {
    let bits = 0;
    if (entry.visibility.vertex) bits |= STAGE.VERTEX;
    if (entry.visibility.fragment) bits |= STAGE.FRAGMENT;
    if (entry.visibility.compute) bits |= STAGE.COMPUTE;
    return bits;
}

function entryToGpu(entry: BindingEntry): Pick<GPUBindGroupLayoutEntry, 'buffer' | 'texture' | 'sampler' | 'storageTexture'> {
    switch (entry.type) {
        case 'uniform':
            return { buffer: { type: 'uniform' } };
        case 'storage':
            return { buffer: { type: 'storage' } };
        case 'readonly-storage':
            return { buffer: { type: 'read-only-storage' } };
        case 'texture': {
            const type = entry.gpuType as { kind?: string; depth?: boolean; access?: string; format?: string } | undefined;
            const viewDimension = textureDimension(entry.gpuType);
            if (type?.kind === 'texture' && type.depth) {
                return { texture: { sampleType: 'depth', viewDimension } };
            }
            if (type?.kind === 'texture' && type.access !== undefined && type.access !== 'sample') {
                return {
                    storageTexture: {
                        access: type.access as GPUStorageTextureAccess,
                        format: (type.format ?? 'rgba8unorm') as GPUTextureFormat,
                        viewDimension,
                    },
                };
            }
            return { texture: { sampleType: 'float', viewDimension } };
        }
        case 'sampler':
            return { sampler: { type: 'filtering' } };
    }
}

/** View dimension for a texture slot, from its GPU type. */
function textureDimension(type: unknown): GPUTextureViewDimension {
    const dim = (type as { kind?: string; dim?: string } | undefined);
    return (dim && dim.kind === 'texture' && dim.dim ? dim.dim : '2d') as GPUTextureViewDimension;
}

function toGpuBlend(blend: { color?: any; alpha?: any }): GPUBlendState {
    const component = (value: any): GPUBlendComponent => value
        ? { srcFactor: value.srcFactor, dstFactor: value.dstFactor, operation: value.operation }
        : { srcFactor: 'one', dstFactor: 'zero', operation: 'add' };
    return { color: component(blend.color), alpha: component(blend.alpha) };
}

/** Build a `GpuDevice` over a raw `GPUDevice`. */
export function webGpuDevice(device: GPUDevice): GpuDevice {
    return new WebGpuDevice(device);
}

/** Build a raw `GPUBindGroupLayout` from a backend-agnostic layout descriptor. */
export function createGpuBindGroupLayout(device: GPUDevice, layout: BindGroupLayout): GPUBindGroupLayout {
    const entries: GPUBindGroupLayoutEntry[] = layout.entries.map((entry) => ({
        binding: entry.binding,
        visibility: visibilityBits(entry),
        ...entryToGpu(entry),
    }));
    return device.createBindGroupLayout({ entries });
}

/** Allocate a raw buffer sized from a schema (a `Field` or `GpuStruct`). */
export function createRawBuffer(
    device: GPUDevice,
    schema: { readonly size: number },
    usage: 'uniform' | 'storage' | 'vertex' | 'index' | 'indirect' | readonly ('uniform' | 'storage' | 'vertex' | 'index' | 'indirect')[],
): GPUBuffer {
    const kinds = Array.isArray(usage) ? usage : [usage];
    const flag = { uniform: BUF.UNIFORM, storage: BUF.STORAGE, vertex: BUF.VERTEX, index: BUF.INDEX, indirect: 0x0100 };
    let bits = 0;
    for (const kind of kinds) bits |= flag[kind];
    return device.createBuffer({ size: schema.size, usage: bits | BUF.COPY_DST });
}

/** Options accepted by {@link createWebGpuContext}. */
export interface WebGpuContextOptions {
    /** An existing device. When omitted, one is requested from `navigator.gpu`. */
    readonly device?: GPUDevice;
}

/**
 * Build a `GpuContext` for WebGPU. When no device is given, an adapter and
 * device are requested from `navigator.gpu`.
 */
export async function createWebGpuContext(options: WebGpuContextOptions = {}): Promise<GpuContext> {
    const device = options.device ?? (await requestWebGpuDevice());
    return new GpuContext({ backend: new GpuBackend(wgslSpec), device: webGpuDevice(device) });
}

/** Request a device from `navigator.gpu`. */
async function requestWebGpuDevice(): Promise<GPUDevice> {
    const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
    if (!gpu) throw new Error('createWebGpuContext: WebGPU is not available');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('createWebGpuContext: no GPU adapter available');
    return adapter.requestDevice();
}

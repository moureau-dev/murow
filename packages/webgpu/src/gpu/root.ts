/**
 * A typegpu-compatible GPU root backed by raw WebGPU.
 *
 * `GpuRoot` owns a `GPUDevice` and hands out buffer and bind group layout
 * handles that mirror the typegpu API (`createBuffer(...).$usage(...)`,
 * `unwrap(...)`, `$.name` layout accessors) while the actual WebGPU resources
 * are created directly. It is the adapter that lets renderer code built for
 * typegpu run on `murow/gpu`.
 */
import { GpuStruct } from 'murow/gpu/schema';
import { handleView } from './environment';
import { sizeOf as schemaSizeOf } from 'murow/gpu/dsl';

/** WebGPU shader stage bits, defined locally so tests need no GPU globals. */
export const SHADER_STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });

/** WebGPU buffer usage bits, defined locally so tests need no GPU globals. */
export const BUFFER_USAGE = Object.freeze({
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
});

/** Symbolic buffer usages accepted by `$usage`. */
export type BufferUsage =
    | 'uniform'
    | 'storage'
    | 'vertex'
    | 'index'
    | 'indirect'
    | 'copy-src'
    | 'copy-dst'
    | 'readback';

const USAGE_FLAG: Record<string, number> = {
    uniform: BUFFER_USAGE.UNIFORM,
    storage: BUFFER_USAGE.STORAGE,
    vertex: BUFFER_USAGE.VERTEX,
    index: BUFFER_USAGE.INDEX,
    indirect: BUFFER_USAGE.INDIRECT,
    'copy-src': BUFFER_USAGE.COPY_SRC,
    'copy-dst': BUFFER_USAGE.COPY_DST,
    readback: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
};

/** Options accepted by {@link GpuRoot}. */
export interface GpuRootOptions {
    readonly device: GPUDevice;
}

/** Options accepted by {@link GpuBuffer}. */
export interface GpuBufferOptions {
    readonly device: GPUDevice;
    readonly schema: any;
}

/**
 * Coerce a value to upload bytes. Array buffers and views pass through, a
 * plain object is packed against the buffer schema, and a typed CPU mirror
 * (an object with an ArrayBuffer-shaped payload) is written field by field.
 */
function encodeValue(schema: any, value: any, byteSize: number): ArrayBufferView | ArrayBuffer {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    const buffer = new ArrayBuffer(byteSize);
    const dv = new DataView(buffer);
    if (schema instanceof GpuStruct) {
        for (const member of schema.fields) {
            const field = member.field;
            if (field && typeof field.write === 'function') field.write(dv, member.offset, value?.[member.name]);
        }
    }
    return buffer;
}

/** A chainable GPU buffer handle mirroring the typegpu buffer surface. */
export class GpuBuffer {
    /** Raw WebGPU buffer, created on first use. */
    __raw: GPUBuffer | null = null;
    /** Byte size derived from the schema. */
    readonly byteSize: number;
    /** Schema this buffer was built from. */
    readonly schema: any;

    private readonly device: GPUDevice;
    private usageFlags = 0;

    constructor(options: GpuBufferOptions) {
        this.device = options.device;
        this.schema = options.schema;
        this.byteSize = schemaSizeOf(options.schema);
    }

    /** Shortcut for the raw buffer. */
    get raw(): GPUBuffer | null {
        return this.__raw;
    }

    /** Set one or more usages and create the underlying buffer. */
    $usage(...usages: BufferUsage[]): this {
        this.usageFlags = BUFFER_USAGE.COPY_DST;
        for (const usage of usages) this.usageFlags |= USAGE_FLAG[usage] ?? 0;
        this.materialize();
        return this;
    }

    /** Upload `data` at offset zero. Creates the buffer if needed. */
    write(data: any): void {
        this.materialize();
        this.device.queue.writeBuffer(this.__raw as GPUBuffer, 0, encodeValue(this.schema, data, this.byteSize) as GPUAllowSharedBufferSource);
    }

    /** Read the buffer back. Forces a GPU to CPU sync; avoid in hot paths. */
    async read(): Promise<ArrayBuffer> {
        this.materialize();
        const raw = this.__raw as GPUBuffer;
        const size = this.byteSize;
        const staging = this.device.createBuffer({
            size,
            usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(raw, 0, staging, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(0x0001);
        const out = staging.getMappedRange().slice(0);
        staging.unmap();
        staging.destroy();
        return out;
    }

    /** Destroy the underlying buffer. */
    destroy(): void {
        this.__raw?.destroy();
    }

    private materialize(): void {
        if (this.__raw) return;
        this.__raw = this.device.createBuffer({
            size: this.byteSize,
            usage: BUFFER_USAGE.COPY_DST | this.usageFlags,
        });
    }
}

/** A binding marker returned by a layout's `$` accessors. */
export interface BindingMarker {
    readonly __binding: { readonly group: number; readonly binding: number; readonly name: string };
}

/** Per-stage visibility of a plain bind group layout entry. */
export interface PlainVisibility {
    readonly vertex?: boolean;
    readonly fragment?: boolean;
    readonly compute?: boolean;
}

/** Resource slot of a plain bind group layout entry. */
export interface PlainBindingResource {
    readonly uniform?: any;
    readonly storage?: any;
    readonly 'read-only-storage'?: any;
    readonly readonlyStorage?: any;
    readonly texture?: any;
    readonly sampler?: any;
    readonly storageTexture?: any;
    /** Texture view dimension, as a sibling of `texture` in a layout entry. */
    readonly viewDimension?: string;
    /** Read-write access for storage buffers. */
    readonly access?: string;
    readonly readwrite?: boolean;
}

/** A plain bind group layout entry with an optional name. */
export interface PlainBindingEntry {
    readonly name?: string;
    readonly binding: number;
    readonly visibility?: PlainVisibility;
    readonly resource: PlainBindingResource;
}

/** A plain, WebGPU-adjacent bind group layout descriptor. */
export interface PlainBindGroupLayoutDescriptor {
    readonly name?: string;
    readonly group?: number;
    readonly entries: readonly PlainBindingEntry[];
}

/** A bind group layout handle with `__raw`, `unwrap`, and `$` accessors. */
export interface LayoutHandle {
    /** Raw layout, once materialized. */
    __raw: GPUBindGroupLayout | undefined;
    /** Plain descriptor this handle was built from. */
    readonly __descriptor: PlainBindGroupLayoutDescriptor;
    /** Bind group index assigned during resolve. */
    __group?: number;
    /** Named binding accessors, IR-valued so shader bodies can read them. */
    readonly $: Record<string, any>;
    /** Materialize the raw layout on a device. */
    __materialize(device: GPUDevice): GPUBindGroupLayout;
    /** The raw layout, or undefined when not yet materialized. */
    unwrap(): GPUBindGroupLayout | undefined;
}

/** Options accepted by {@link createLayoutHandle}. */
export interface LayoutHandleOptions {
    readonly descriptor: PlainBindGroupLayoutDescriptor;
    readonly group: number;
    readonly raw?: GPUBindGroupLayout;
    readonly device?: GPUDevice;
}

/**
 * Build a layout handle from a plain descriptor.
 *
 * The `$` accessors are a Proxy that returns binding markers by name. Actual
 * shader binding comes from the generated IR, so the markers are best effort
 * and carry only group, binding, and name.
 */
export function createLayoutHandle(options: LayoutHandleOptions): LayoutHandle {
    let group = options.group;
    let raw = options.raw;

    const handle: LayoutHandle = {
        __raw: raw,
        __descriptor: options.descriptor,
        __group: group,
        get $(): Record<string, any> {
            return handleView(handle, group).$ as Record<string, any>;
        },
        __materialize(device: GPUDevice): GPUBindGroupLayout {
            if (!raw) raw = device.createBindGroupLayout(toGpuBindGroupLayoutDescriptor(options.descriptor));
            return raw;
        },
        unwrap(): GPUBindGroupLayout | undefined {
            return raw;
        },
    };
    // Keep the assigned group in sync with the getter closure.
    Object.defineProperty(handle, '__group', {
        get: () => group,
        set: (value: number) => { group = value; },
        enumerable: true,
        configurable: true,
    });
    return handle;
}

function visibilityFlags(visibility: PlainVisibility = {}, storageOnly = false): number {
    // WebGPU rejects read-write storage visible to any stage but compute.
    if (storageOnly) return SHADER_STAGE.COMPUTE;
    let flags = 0;
    if (visibility.vertex) flags |= SHADER_STAGE.VERTEX;
    if (visibility.fragment) flags |= SHADER_STAGE.FRAGMENT;
    if (visibility.compute) flags |= SHADER_STAGE.COMPUTE;
    if (flags === 0) flags = SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT;
    return flags;
}

/** Read-write storage, which WebGPU only allows in compute stages. */
function isMutableStorage(resource: PlainBindingResource): boolean {
    return resource.storage !== undefined
        && (resource.access === 'mutable' || resource.readwrite === true);
}

function bufferBinding(kind: 'uniform' | 'storage' | 'read-only-storage', schema: any, mutable = false): any {
    const binding: any = { type: kind };
    if (mutable) binding.access = 'read_write';
    if (schema !== undefined && schema !== null) {
        const size = schemaSizeOf(schema);
        if (size > 0) binding.minBindingSize = size;
    }
    return { buffer: binding };
}

function resourceToGpu(resource: PlainBindingResource): any {
    if (resource.uniform !== undefined) return bufferBinding('uniform', resource.uniform);
    if (resource.storage !== undefined) {
        const mutable = isMutableStorage(resource);
        return bufferBinding(mutable ? 'storage' : 'read-only-storage', resource.storage, mutable);
    }
    if (resource['read-only-storage'] !== undefined) return bufferBinding('read-only-storage', resource['read-only-storage']);
    if (resource.readonlyStorage !== undefined) return bufferBinding('read-only-storage', resource.readonlyStorage);
    if (resource.texture !== undefined) {
        const texture = resource.texture ?? {};
        return {
            texture: {
                sampleType: typeof texture === 'string' ? texture : texture.sampleType ?? 'float',
                viewDimension: (typeof texture === 'object' && texture.viewDimension) || resource.viewDimension || '2d',
                multisampled: (typeof texture === 'object' && texture.multisampled) ?? false,
            },
        };
    }
    if (resource.sampler !== undefined) {
        const sampler = resource.sampler ?? {};
        return { sampler: { type: typeof sampler === 'string' ? sampler : sampler.type ?? 'filtering' } };
    }
    if (resource.storageTexture !== undefined) {
        const storageTexture = resource.storageTexture ?? {};
        return {
            storageTexture: {
                format: storageTexture.format ?? 'rgba8unorm',
                access: storageTexture.access ?? 'write-only',
                viewDimension: storageTexture.viewDimension ?? '2d',
            },
        };
    }
    return {};
}

/** Convert a plain descriptor to a WebGPU bind group layout descriptor. */
export function toGpuBindGroupLayoutDescriptor(descriptor: PlainBindGroupLayoutDescriptor): GPUBindGroupLayoutDescriptor {
    return {
        label: descriptor.name,
        entries: descriptor.entries.map((entry) => ({
            binding: entry.binding,
            visibility: visibilityFlags(entry.visibility, isMutableStorage(entry.resource)),
            ...resourceToGpu(entry.resource),
        })),
    } as GPUBindGroupLayoutDescriptor;
}

/**
 * The typegpu-compatible root. Wraps a `GPUDevice` and mirrors the typegpu
 * root surface over raw WebGPU calls.
 */
export class GpuRoot {
    private readonly _device: GPUDevice;

    constructor(options: GpuRootOptions) {
        this._device = options.device;
    }

    /** Build a root around an existing device. */
    static fromDevice(device: GPUDevice): GpuRoot {
        return new GpuRoot({ device });
    }

    /** The wrapped WebGPU device. */
    get device(): GPUDevice {
        return this._device;
    }

    /** Create a buffer handle sized from `schema`. */
    createBuffer(schema: any): GpuBuffer {
        return new GpuBuffer({ device: this._device, schema });
    }

    /**
     * Return the raw resource behind a handle. Buffers and layouts carry
     * `__raw`; otherwise a handle that can materialize itself is asked to.
     */
    unwrap(resource: any): any {
        if (resource === null || resource === undefined) return resource;
        if (resource.__raw) return resource.__raw;
        if (resource.raw) return resource.raw;
        if (typeof resource.__materialize === 'function') {
            const raw = resource.__materialize(this._device);
            resource.__raw = raw;
            return raw;
        }
        return resource;
    }

    /** Build a bind group layout from a plain descriptor. */
    bindGroupLayout(descriptor: PlainBindGroupLayoutDescriptor): LayoutHandle {
        const group = descriptor.group ?? 0;
        const raw = this._device.createBindGroupLayout(toGpuBindGroupLayoutDescriptor(descriptor));
        return createLayoutHandle({ descriptor, group, raw, device: this._device });
    }

    /**
     * Build a bind group. Accepts either a raw descriptor or a layout handle
     * plus a record of named resources.
     */
    createBindGroup(layoutOrDescriptor: any, entries?: Record<string, any>): GPUBindGroup {
        if (entries === undefined) return this._device.createBindGroup(layoutOrDescriptor);

        const descriptor = layoutOrDescriptor.__descriptor as PlainBindGroupLayoutDescriptor;
        const rawEntries: GPUBindGroupEntry[] = [];
        for (const entry of descriptor.entries) {
            if (!entry.name) continue;
            const resource = this.unwrap(entries[entry.name]);
            if (resource === undefined) continue;
            rawEntries.push({
                binding: entry.binding,
                resource: isTextureLike(resource) ? (resource as GPUTextureView) : { buffer: resource as GPUBuffer },
            });
        }
        return this._device.createBindGroup({
            layout: this.unwrap(layoutOrDescriptor) as GPUBindGroupLayout,
            entries: rawEntries,
        });
    }

    /**
     * Build a render pipeline. A raw descriptor passes through; a typegpu-style
     * descriptor with `vertex`/`fragment` entries is lowered and linked.
     */
    createRenderPipeline(descriptor: any): any {
        if (descriptor && descriptor.vertex && descriptor.vertex.module) {
            return this._device.createRenderPipeline(descriptor);
        }
        const resolved = this.resolveEntries([descriptor.vertex, descriptor.fragment]);
        const module = this._device.createShaderModule({ code: resolved.code });
        const targets = Array.isArray(descriptor.targets) ? descriptor.targets : [descriptor.targets];
        return this._device.createRenderPipeline({
            layout: this._device.createPipelineLayout({
                bindGroupLayouts: resolved.layouts.map((layout) => this.unwrap(layout) as GPUBindGroupLayout),
            }),
            vertex: { module },
            fragment: { module, targets },
            primitive: descriptor.primitive,
            depthStencil: descriptor.depthStencil,
        });
    }

    /**
     * Build a compute pipeline. A raw descriptor passes through; a typegpu-style
     * descriptor receives the resolved module and linked layout.
     */
    createComputePipeline(descriptor: any): any {
        if (descriptor && descriptor.compute && descriptor.compute.module) {
            return this._device.createComputePipeline(descriptor);
        }
        const resolved = this.resolveEntries([descriptor.compute]);
        const module = this._device.createShaderModule({ code: resolved.code });
        const raw = this._device.createComputePipeline({
            layout: this._device.createPipelineLayout({
                bindGroupLayouts: resolved.layouts.map((layout) => this.unwrap(layout) as GPUBindGroupLayout),
            }),
            compute: { module },
        });
        return new ComputePipelineHandle(raw, this._device);
    }

    /** Destroy any GPU resources owned by the root. */
    destroy(): void {
        // Buffers are owned by their handles; nothing device-wide to release.
    }

    private resolveEntries(entries: readonly any[]): { code: string; layouts: LayoutHandle[] } {
        if (!entryResolver) throw new Error('GpuRoot: no shader resolver installed');
        return entryResolver(entries);
    }
}

/** Map a resolved value to a texture view vs a buffer. */
function isTextureLike(resource: any): boolean {
    return resource && typeof resource === 'object' && typeof resource.createView === 'function';
}

/**
 * A compute pipeline handle mirroring the typegpu surface the compute builder
 * uses: `with(bindGroup).dispatchWorkgroups(...)` and `__raw`.
 */
export class ComputePipelineHandle {
    readonly __raw: GPUComputePipeline;
    private readonly device: GPUDevice;
    private bindGroup: GPUBindGroup | undefined;

    constructor(raw: GPUComputePipeline, device: GPUDevice) {
        this.__raw = raw;
        this.device = device;
    }

    /** Bind a bind group for subsequent dispatches. */
    with(bindGroup: GPUBindGroup): this {
        this.bindGroup = bindGroup;
        return this;
    }

    /** Dispatch workgroups in a fresh command encoder. */
    dispatchWorkgroups(x: number, y = 1, z = 1): void {
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.__raw);
        if (this.bindGroup) pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(x, y, z);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
}

/** Resolves shader entries to WGSL; installed by the `tgpu` facade. */
type EntryResolver = (entries: readonly any[]) => { code: string; layouts: LayoutHandle[] };

let entryResolver: EntryResolver | null = null;

/** Install the shader resolver used by the typegpu-style pipeline builders. */
export function setGpuResolver(resolver: EntryResolver): void {
    entryResolver = resolver;
}

/** Convenience singleton factory mirroring `tgpu.initFromDevice`. */
export function createRoot(options: GpuRootOptions): GpuRoot {
    return new GpuRoot(options);
}

export { GpuStruct };

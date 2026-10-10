/**
 * ComputeBuilder — fluent builder for GPU compute kernels.
 *
 * Compiles a `murow/gpu` compute shader through the WGSL backend and creates the
 * raw WebGPU resources directly. The kernel body receives `(input, bindings)`:
 * `input` is the compute builtins, `bindings.buffers` the buffer accessors.
 *
 * Usage:
 * ```ts
 * const physics = renderer.compute
 *     .create('particle-physics', { workgroupSize: 64 })
 *     .buffers({
 *         particles: { storage: d.arrayOf(Particle, MAX), readwrite: true },
 *         config: { uniform: Config },
 *     })
 *     .shader(({ globalId }, { buffers }) => {
 *         const idx = globalId.x;
 *         const p = buffers.particles[idx];
 *         // ... update particle
 *     })
 *     .build();
 * ```
 */
import {
    GpuBackend,
    GpuBindGroupLayout,
    GpuProgram,
    GpuShader,
    type BindingSpec,
} from 'murow/gpu';
import { createGpuBindGroupLayout } from '../gpu/device';
import { d, sizeOf } from 'murow/gpu/dsl';
import { wgslSpec } from '../gpu/backend';

// =============================================================================
// Types
// =============================================================================

/** Buffer definition for a compute kernel. */
export interface ComputeBufferDef<TStorage = any, TUniform = any> {
    /** Storage buffer (read-only or read-write). Provide an `arrayOf(...)` schema. */
    storage?: TStorage;
    /** Uniform buffer. Provide a struct schema. */
    uniform?: TUniform;
    /** If true, the storage buffer is read-write (`storage, read_write`). */
    readwrite?: boolean;
    /** External buffer to use instead of allocating one. Raw or a facade handle. */
    external?: GPUBuffer | { raw?: GPUBuffer | null; __raw?: GPUBuffer | null };
}

type BufferDataType<T extends ComputeBufferDef> =
    T extends { storage: infer S } ? S :
    T extends { uniform: infer U } ? U :
    unknown;

export interface ComputeOptions {
    /** Invocations per workgroup. Default 64. */
    workgroupSize: number | [number, number] | [number, number, number];
}

/** Compute shader input builtins. */
export interface ComputeInput {
    readonly globalId: { x: number; y: number; z: number };
    readonly localId: { x: number; y: number; z: number };
    readonly localIndex: number;
    readonly workgroupId: { x: number; y: number; z: number };
    readonly numWorkgroups: { x: number; y: number; z: number };
}

/** Buffer accessors passed to the compute body as `bindings.buffers`. */
export type ComputeBufferAccessors<TBuffers extends Record<string, ComputeBufferDef>> = {
    readonly [K in keyof TBuffers]: BufferDataType<TBuffers[K]>;
};

/** Compute shader function: `(input, bindings)` where bindings has `buffers`. */
type ComputeShaderFn<TBuffers extends Record<string, ComputeBufferDef>> =
    (input: ComputeInput, bindings: { buffers: ComputeBufferAccessors<TBuffers> }) => void;

// =============================================================================
// ComputeKernel (built result)
// =============================================================================

/** A compiled compute kernel with its buffers and pipeline. */
export class ComputeKernel<TBuffers extends Record<string, ComputeBufferDef> = Record<string, ComputeBufferDef>> {
    readonly name: string;

    private readonly device: GPUDevice;
    private readonly pipeline: GPUComputePipeline;
    private readonly bindGroup: GPUBindGroup;
    private readonly buffers: Record<string, { raw: GPUBuffer; schema: any; size: number }>;
    private readonly workgroupSize: [number, number, number];

    constructor(
        name: string,
        device: GPUDevice,
        pipeline: GPUComputePipeline,
        bindGroup: GPUBindGroup,
        buffers: Record<string, { raw: GPUBuffer; schema: any; size: number }>,
        workgroupSize: [number, number, number],
    ) {
        this.name = name;
        this.device = device;
        this.pipeline = pipeline;
        this.bindGroup = bindGroup;
        this.buffers = buffers;
        this.workgroupSize = workgroupSize;
    }

    /** Write data to a uniform or storage buffer by name. */
    write<K extends keyof TBuffers & string>(bufferName: K, data: unknown): void {
        const buffer = this.buffers[bufferName];
        if (!buffer) throw new Error(`Buffer "${bufferName}" not found in compute kernel "${this.name}"`);
        this.device.queue.writeBuffer(buffer.raw, 0, pack(buffer.schema, data) as GPUAllowSharedBufferSource);
    }

    /** Dispatch the compute kernel in its own command buffer. */
    dispatch(countOrGroups: number | [number, number?, number?]): void {
        const encoder = this.device.createCommandEncoder();
        this.encode(encoder, countOrGroups);
        this.device.queue.submit([encoder.finish()]);
    }

    /** Encode a dispatch into an existing command encoder. */
    encode(encoder: GPUCommandEncoder, countOrGroups: number | [number, number?, number?]): void {
        const [x, y, z] = this.resolveGroups(countOrGroups);
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(x, y, z);
        pass.end();
    }

    /** Read data back from a storage buffer. Forces a GPU to CPU sync. */
    async read(bufferName: keyof TBuffers & string): Promise<ArrayBuffer> {
        const buffer = this.buffers[bufferName];
        if (!buffer) throw new Error(`Buffer "${bufferName}" not found in compute kernel "${this.name}"`);
        const staging = this.device.createBuffer({
            size: buffer.size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer.raw, 0, staging, 0, buffer.size);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const out = staging.getMappedRange().slice(0);
        staging.unmap();
        staging.destroy();
        return out;
    }

    /** The raw WebGPU buffer for a name, for sharing between kernels. */
    getBuffer(bufferName: keyof TBuffers & string): GPUBuffer {
        const buffer = this.buffers[bufferName];
        if (!buffer) throw new Error(`Buffer "${bufferName}" not found in compute kernel "${this.name}"`);
        return buffer.raw;
    }

    /** Destroy every buffer owned by this kernel. */
    destroy(): void {
        for (const buffer of Object.values(this.buffers)) buffer.raw.destroy();
    }

    private resolveGroups(countOrGroups: number | [number, number?, number?]): [number, number, number] {
        if (typeof countOrGroups === 'number') {
            return [Math.ceil(countOrGroups / this.workgroupSize[0]), 1, 1];
        }
        return [countOrGroups[0], countOrGroups[1] ?? 1, countOrGroups[2] ?? 1];
    }
}

// =============================================================================
// ComputeBuilder
// =============================================================================

/** Fluent builder for a GPU compute kernel. */
export class ComputeBuilder<
    TBuffers extends Record<string, ComputeBufferDef> = Record<string, never>,
> {
    private _bufferDefs: TBuffers | null = null;
    private _shaderFn: ComputeShaderFn<TBuffers> | null = null;
    private readonly _workgroupSize: [number, number, number];

    private readonly device: GPUDevice;

    constructor(
        private readonly name: string,
        options: ComputeOptions,
        deviceOrRoot: GPUDevice | { device: GPUDevice },
    ) {
        this.device = deviceOrRoot && typeof deviceOrRoot === 'object' && 'device' in deviceOrRoot
            ? (deviceOrRoot as { device: GPUDevice }).device
            : (deviceOrRoot as GPUDevice);
        if (typeof options.workgroupSize === 'number') this._workgroupSize = [options.workgroupSize, 1, 1];
        else if (options.workgroupSize.length === 2) this._workgroupSize = [options.workgroupSize[0], options.workgroupSize[1], 1];
        else this._workgroupSize = options.workgroupSize;
    }

    /** Define the kernel's buffers by name. */
    buffers<B extends Record<string, ComputeBufferDef>>(defs: B): ComputeBuilder<B> {
        const next = this as unknown as ComputeBuilder<B>;
        next._bufferDefs = defs;
        return next;
    }

    /** Define the kernel body: `(input, bindings)`. */
    shader(fn: ComputeShaderFn<TBuffers>): this {
        this._shaderFn = fn;
        return this;
    }

    /** Compile the kernel and create its buffers, bind group, and pipeline. */
    build(): ComputeKernel<TBuffers> {
        if (!this._bufferDefs) throw new Error(`Compute "${this.name}": buffers() is required`);
        if (!this._shaderFn) throw new Error(`Compute "${this.name}": shader() is required`);
        const device = this.device;
        const defs = this._bufferDefs;

        const spec: Record<string, BindingSpec> = {};
        for (const name of Object.keys(defs)) {
            const def = defs[name]!;
            if (def.storage) spec[name] = { storage: def.storage, readwrite: def.readwrite === true };
            else if (def.uniform) spec[name] = { uniform: def.uniform };
        }
        const layout = new GpuBindGroupLayout(spec);

        const shader = GpuShader.compute(
            {
                in: {
                    globalId: d.builtin.globalInvocationId,
                    localId: d.builtin.localInvocationId,
                    localIndex: d.builtin.localInvocationIndex,
                    workgroupId: d.builtin.workgroupId,
                    numWorkgroups: d.builtin.numWorkgroups,
                },
                bindings: { buffers: layout },
                workgroup: this._workgroupSize,
            },
            this._shaderFn as unknown as (input: unknown, bindings: unknown) => unknown,
        );
        const { code } = new GpuBackend(wgslSpec).compile(GpuProgram.link([shader]));

        const module = device.createShaderModule({ code, label: this.name });
        const rawLayout = createGpuBindGroupLayout(device, layout.toDescriptor());
        const pipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [rawLayout] }),
            compute: { module, entryPoint: 'cs_main' },
            label: this.name,
        });

        const buffers: Record<string, { raw: GPUBuffer; schema: any; size: number }> = {};
        const entries: GPUBindGroupEntry[] = [];
        for (const name of Object.keys(defs)) {
            const def = defs[name]!;
            const schema = def.storage ?? def.uniform;
            const size = sizeOf(schema);
            const usage = def.uniform
                ? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
            const raw = def.external ? unwrapRaw(def.external) : device.createBuffer({ size, usage });
            buffers[name] = { raw, schema, size };
            entries.push({ binding: layout.slot(name)!.binding, resource: { buffer: raw } });
        }
        const bindGroup = device.createBindGroup({ layout: rawLayout, entries });
        return new ComputeKernel<TBuffers>(this.name, device, pipeline, bindGroup, buffers, this._workgroupSize);
    }
}

/** Resolve a raw `GPUBuffer` from a raw buffer or a facade handle. */
function unwrapRaw(buffer: GPUBuffer | { raw?: GPUBuffer | null; __raw?: GPUBuffer | null }): GPUBuffer {
    const candidate = buffer as { raw?: GPUBuffer | null; __raw?: GPUBuffer | null };
    return (candidate.raw ?? candidate.__raw ?? (buffer as GPUBuffer));
}

/** Pack a schema value into bytes for upload. */
function pack(schema: any, value: unknown): Uint8Array {
    const size = sizeOf(schema);
    const buffer = new ArrayBuffer(size);
    const dv = new DataView(buffer);
    if (Array.isArray(schema.fields)) {
        for (const member of schema.fields) member.field.write(dv, member.offset, (value as Record<string, unknown>)?.[member.name]);
    } else {
        schema.write(dv, 0, value);
    }
    return new Uint8Array(buffer);
}

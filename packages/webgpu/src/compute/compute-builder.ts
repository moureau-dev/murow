/**
 * ComputeBuilder — fluent builder for GPU compute shaders.
 * Same declarative pattern as the geometry builder: type-safe, no `'use gpu'`,
 * runtime-transpiled.
 *
 * Usage:
 * ```ts
 * const physics = renderer
 *     .createCompute('particle-physics', { workgroupSize: 64 })
 *     .buffers({
 *         particles: { storage: d.arrayOf(ParticleStruct, MAX), readwrite: true },
 *         config: { uniform: ConfigStruct },
 *     })
 *     .shader(({ particles, config, globalId }) => {
 *         const idx = globalId.x;
 *         const p = particles[idx];
 *         // ... update particle
 *     })
 *     .build();
 *
 * physics.write('config', { deltaTime: dt, gravity: -9.8 });
 * physics.dispatch(MAX);
 * ```
 */
import tgpu from 'typegpu';
import type { TgpuRoot, TgpuBuffer, TgpuBindGroupLayout, TgpuBindGroup, TgpuComputePipeline } from 'typegpu';
import * as d from 'typegpu/data';
import type { AnyData } from 'typegpu/data';
import * as std from 'typegpu/std';
import { attachShaderMetadata } from '../shaders/runtime-transpile';

// =============================================================================
// Types
// =============================================================================

/** Buffer definition for a compute shader. */
export interface ComputeBufferDef<TStorage extends AnyData = AnyData, TUniform extends AnyData = AnyData> {
    /** Storage buffer (read-only or read-write). Provide an arrayOf(...) schema. */
    storage?: TStorage;
    /** Uniform buffer. Provide a struct schema. */
    uniform?: TUniform;
    /** If true, storage buffer is read-write (`storage, read_write`). Default: false (read-only). */
    readwrite?: boolean;
}

/** Extract the data type from a buffer definition. */
type BufferDataType<T extends ComputeBufferDef> =
    T extends { storage: infer S } ? S :
    T extends { uniform: infer U } ? U :
    unknown;

export interface ComputeOptions {
    /** Number of invocations per workgroup. Default: 64. */
    workgroupSize: number | [number, number] | [number, number, number];
}

/** Compute shader input builtins. */
export interface ComputeInput {
    /** Global invocation ID (x, y, z). */
    globalId: { x: number; y: number; z: number };
    /** Local invocation ID within workgroup. */
    localId: { x: number; y: number; z: number };
    /** Local invocation index (flattened). */
    localIndex: number;
    /** Workgroup ID. */
    workgroupId: { x: number; y: number; z: number };
    /** Number of workgroups dispatched. */
    numWorkgroups: { x: number; y: number; z: number };
}

/**
 * Context passed to the compute shader function.
 * Buffer names and their data types are inferred from `.buffers()`.
 */
export type ComputeShaderContext<TBuffers extends Record<string, ComputeBufferDef>> = {
    readonly [K in keyof TBuffers]: BufferDataType<TBuffers[K]>;
} & ComputeInput;

type ComputeShaderFn<TBuffers extends Record<string, ComputeBufferDef>> =
    (ctx: ComputeShaderContext<TBuffers>) => void;

// =============================================================================
// ComputeKernel (built result)
// =============================================================================

export class ComputeKernel<TBuffers extends Record<string, ComputeBufferDef> = Record<string, ComputeBufferDef>> {
    readonly name: string;

    private root: TgpuRoot;
    private pipeline: TgpuComputePipeline;
    private bindGroup: TgpuBindGroup;
    private buffers: Map<string, TgpuBuffer<unknown>>;
    private workgroupSize: [number, number, number];

    constructor(
        name: string,
        root: TgpuRoot,
        pipeline: TgpuComputePipeline,
        bindGroup: TgpuBindGroup,
        buffers: Map<string, TgpuBuffer<unknown>>,
        workgroupSize: [number, number, number],
    ) {
        this.name = name;
        this.root = root;
        this.pipeline = pipeline;
        this.bindGroup = bindGroup;
        this.buffers = buffers;
        this.workgroupSize = workgroupSize;
    }

    /**
     * Write data to a uniform or storage buffer by name.
     */
    write<K extends keyof TBuffers & string>(bufferName: K, data: unknown): void {
        const buffer = this.buffers.get(bufferName);
        if (!buffer) throw new Error(`Buffer "${bufferName}" not found in compute kernel "${this.name}"`);
        buffer.write(data as never);
    }

    /**
     * Dispatch the compute shader.
     * @param countOrGroups Total invocation count (divided by workgroupSize automatically),
     *                      or explicit [x, y, z] workgroup counts.
     */
    dispatch(countOrGroups: number | [number, number?, number?]): void {
        let groupsX: number;
        let groupsY = 1;
        let groupsZ = 1;

        if (typeof countOrGroups === 'number') {
            groupsX = Math.ceil(countOrGroups / this.workgroupSize[0]);
        } else {
            groupsX = countOrGroups[0];
            groupsY = countOrGroups[1] ?? 1;
            groupsZ = countOrGroups[2] ?? 1;
        }

        (this.pipeline as unknown as {
            with(bg: TgpuBindGroup): { dispatchWorkgroups(x: number, y?: number, z?: number): void }
        })
            .with(this.bindGroup)
            .dispatchWorkgroups(groupsX, groupsY, groupsZ);
    }

    /**
     * Read data back from a storage buffer.
     */
    async read(bufferName: keyof TBuffers & string): Promise<unknown> {
        const buffer = this.buffers.get(bufferName);
        if (!buffer) throw new Error(`Buffer "${bufferName}" not found in compute kernel "${this.name}"`);
        return buffer.read();
    }

    destroy(): void {
        for (const buf of this.buffers.values()) {
            buf.destroy();
        }
    }
}

// =============================================================================
// ComputeBuilder
// =============================================================================

export class ComputeBuilder<
    TBuffers extends Record<string, ComputeBufferDef> = Record<string, never>,
> {
    private _name: string;
    private _root: TgpuRoot;
    private _workgroupSize: [number, number, number];
    private _bufferDefs: TBuffers | null = null;
    private _shaderFn: ComputeShaderFn<TBuffers> | null = null;

    constructor(name: string, options: ComputeOptions, root: TgpuRoot) {
        this._name = name;
        this._root = root;

        // Normalize workgroup size to [x, y, z]
        if (typeof options.workgroupSize === 'number') {
            this._workgroupSize = [options.workgroupSize, 1, 1];
        } else if (options.workgroupSize.length === 2) {
            this._workgroupSize = [options.workgroupSize[0], options.workgroupSize[1], 1];
        } else {
            this._workgroupSize = options.workgroupSize;
        }
    }

    /**
     * Define the compute shader's buffers.
     * Each entry maps a name to a storage or uniform buffer definition.
     */
    buffers<B extends Record<string, ComputeBufferDef>>(defs: B): ComputeBuilder<B> {
        const next = this as unknown as ComputeBuilder<B>;
        next._bufferDefs = defs;
        return next;
    }

    /**
     * Define the compute shader body.
     * Receives a context with buffer accessors and compute builtins.
     * No `'use gpu'` needed — the builder handles transpilation.
     */
    shader(fn: ComputeShaderFn<TBuffers>): this {
        this._shaderFn = fn;
        return this;
    }

    build(): ComputeKernel<TBuffers> {
        if (!this._bufferDefs) throw new Error(`Compute "${this._name}": buffers() is required`);
        if (!this._shaderFn) throw new Error(`Compute "${this._name}": shader() is required`);

        const root = this._root;
        const bufferDefs = this._bufferDefs;

        // Build bind group layout entries
        const layoutEntries: Record<string, unknown> = {};
        for (const [name, def] of Object.entries(bufferDefs)) {
            if (def.storage) {
                layoutEntries[name] = def.readwrite
                    ? { storage: def.storage, access: 'mutable' }
                    : { storage: def.storage };
            } else if (def.uniform) {
                layoutEntries[name] = { uniform: def.uniform };
            }
        }

        const layout = tgpu.bindGroupLayout(layoutEntries as Parameters<typeof tgpu.bindGroupLayout>[0]);

        // Create buffers
        const tgpuBuffers = new Map<string, TgpuBuffer<unknown>>();
        const bindGroupEntries: Record<string, unknown> = {};

        for (const [name, def] of Object.entries(bufferDefs)) {
            if (def.storage) {
                const buf = root.createBuffer(def.storage as Parameters<typeof root.createBuffer>[0])
                    .$usage('storage') as TgpuBuffer<unknown>;
                tgpuBuffers.set(name, buf);
                bindGroupEntries[name] = buf;
            } else if (def.uniform) {
                const buf = root.createBuffer(def.uniform as Parameters<typeof root.createBuffer>[0])
                    .$usage('uniform') as TgpuBuffer<unknown>;
                tgpuBuffers.set(name, buf);
                bindGroupEntries[name] = buf;
            }
        }

        const bindGroup = (root as unknown as { createBindGroup(l: TgpuBindGroupLayout, e: Record<string, unknown>): TgpuBindGroup })
            .createBindGroup(layout, bindGroupEntries);

        // Build compute function with runtime transpilation
        // The shader fn signature is (ctx) => void, where ctx has buffer names + builtins.
        // We need to strip that single param and make the buffer names + builtins externals.
        attachShaderMetadata(this._shaderFn, () => {
            const externals: Record<string, unknown> = {
                d,
                std,
            };
            // Buffer accessors from the layout
            const bound = layout.$;
            for (const name of Object.keys(bufferDefs)) {
                externals[name] = (bound as Record<string, unknown>)[name];
            }
            return externals;
        }, true);

        // Build compute input builtins
        const computeIn: Record<string, unknown> = {
            globalId: d.builtin.globalInvocationId,
            localId: d.builtin.localInvocationId,
            localIndex: d.builtin.localInvocationIndex,
            workgroupId: d.builtin.workgroupId,
            numWorkgroups: d.builtin.numWorkgroups,
        };

        const computeFn = tgpu.computeFn(
            { in: computeIn, workgroupSize: this._workgroupSize } as Parameters<typeof tgpu.computeFn>[0],
        )(this._shaderFn as unknown as Parameters<ReturnType<typeof tgpu.computeFn>>[0]);

        const pipeline = root.createComputePipeline({
            compute: computeFn,
        } as Parameters<typeof root.createComputePipeline>[0]);

        return new ComputeKernel<TBuffers>(
            this._name, root, pipeline, bindGroup, tgpuBuffers, this._workgroupSize,
        );
    }
}

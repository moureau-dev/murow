/**
 * An in-memory GPU device that records every call.
 *
 * `RecordingDevice` implements {@link GpuDevice} without touching a GPU. Each
 * call returns an incrementing integer handle and appends to an array, so tests
 * can assert on resource creation, render commands, and compute dispatches.
 */

import type { Capabilities } from '../codegen/backend';
import { ALL_CAPABILITIES } from '../codegen/backend';
import type { GpuStruct } from '../schema/struct';
import type { BindGroupLayout } from '../descriptors/bind-group';
import type { PipelineDescriptor } from '../descriptors/pipeline';
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
} from './gpu-device';

/** Record of a created buffer. */
export interface BufferRecord {
    readonly handle: GpuBufferHandle;
    readonly size: number;
    readonly usage: BufferUsage;
    readonly struct?: GpuStruct;
    destroyed: boolean;
}

/** Record of a created texture. */
export interface TextureRecord {
    readonly handle: GpuTextureHandle;
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly usage: GpuTextureOptions['usage'];
    destroyed: boolean;
}

/** Record of a created bind group. */
export interface BindGroupRecord {
    readonly handle: GpuBindGroupHandle;
    readonly layout: BindGroupLayout;
    readonly entries: readonly GpuBindGroupEntry[];
}

/** Record of a created pipeline. */
export interface PipelineRecord {
    readonly handle: GpuPipelineHandle;
    readonly descriptor: PipelineDescriptor;
}

/** A recorded draw command. */
export interface DrawRecord {
    readonly count: number;
    readonly firstInstance: number;
    readonly instanceCount: number;
}

/** A recorded compute dispatch. */
export interface DispatchRecord {
    readonly workgroupsX: number;
    readonly workgroupsY: number;
    readonly workgroupsZ: number;
}

/** Every call recorded by a {@link RecordingDevice}. */
export type DeviceCall =
    | { readonly kind: 'create-buffer'; readonly buffer: GpuBufferHandle; readonly options: GpuBufferOptions }
    | { readonly kind: 'write-buffer'; readonly buffer: GpuBufferHandle; readonly offset: number; readonly data: ArrayBufferView }
    | { readonly kind: 'destroy-buffer'; readonly buffer: GpuBufferHandle }
    | { readonly kind: 'create-texture'; readonly texture: GpuTextureHandle; readonly options: GpuTextureOptions }
    | {
          readonly kind: 'create-bind-group';
          readonly group: GpuBindGroupHandle;
          readonly layout: BindGroupLayout;
          readonly entries: readonly GpuBindGroupEntry[];
      }
    | { readonly kind: 'create-pipeline'; readonly pipeline: GpuPipelineHandle; readonly descriptor: PipelineDescriptor }
    | { readonly kind: 'begin-render-pass'; readonly options: RenderPassOptions }
    | { readonly kind: 'set-pipeline'; readonly pipeline: GpuPipelineHandle }
    | { readonly kind: 'set-bind-group'; readonly index: number; readonly group: GpuBindGroupHandle }
    | { readonly kind: 'draw'; readonly count: number; readonly firstInstance: number; readonly instanceCount: number }
    | { readonly kind: 'end-render-pass' }
    | {
          readonly kind: 'dispatch';
          readonly workgroupsX: number;
          readonly workgroupsY: number;
          readonly workgroupsZ: number;
      }
    | { readonly kind: 'destroy' };

/** Call discriminator. */
export type DeviceCallKind = DeviceCall['kind'];

/** Options accepted by {@link RecordingDevice}. */
export interface RecordingDeviceOptions {
    /** Advertised capabilities. Defaults to everything enabled. */
    readonly capabilities?: Capabilities;
}

/** A {@link GpuDevice} that records calls in memory instead of issuing them. */
export class RecordingDevice implements GpuDevice {
    /** Capabilities this device reports. */
    readonly capabilities: Capabilities;
    /** Buffers created through this device, in order. */
    readonly buffers: BufferRecord[] = [];
    /** Textures created through this device, in order. */
    readonly textures: TextureRecord[] = [];
    /** Bind groups created through this device, in order. */
    readonly bindGroups: BindGroupRecord[] = [];
    /** Pipelines created through this device, in order. */
    readonly pipelines: PipelineRecord[] = [];
    /** Every call, in issue order. */
    readonly calls: DeviceCall[] = [];
    /** Draw commands, in issue order. */
    readonly draws: DrawRecord[] = [];
    /** Compute dispatches, in issue order. */
    readonly dispatches: DispatchRecord[] = [];

    private nextBuffer = 1;
    private nextTexture = 1;
    private nextBindGroup = 1;
    private nextPipeline = 1;

    private activePipeline: GpuPipelineHandle | undefined;
    private readonly boundGroups: (GpuBindGroupHandle | undefined)[] = [];
    private _destroyed = false;

    constructor(options: RecordingDeviceOptions = {}) {
        this.capabilities = options.capabilities ?? ALL_CAPABILITIES;
    }

    /** Whether `destroy` has been called. */
    get destroyed(): boolean {
        return this._destroyed;
    }

    createBuffer(options: GpuBufferOptions): GpuBufferHandle {
        const handle = this.nextBuffer++ as GpuBufferHandle;
        let size: number;
        let usage: BufferUsage;
        let struct: GpuStruct | undefined;
        if ('struct' in options) {
            struct = options.struct;
            size = options.struct.size;
            usage = 'uniform';
        } else {
            size = options.size;
            usage = options.usage;
        }
        this.buffers.push({ handle, size, usage, struct, destroyed: false });
        this.calls.push({ kind: 'create-buffer', buffer: handle, options });
        return handle;
    }

    writeBuffer(buffer: GpuBufferHandle, offset: number, data: ArrayBufferView): void {
        this.calls.push({ kind: 'write-buffer', buffer, offset, data });
    }

    destroyBuffer(buffer: GpuBufferHandle): void {
        for (const record of this.buffers) {
            if (record.handle === buffer) record.destroyed = true;
        }
        this.calls.push({ kind: 'destroy-buffer', buffer });
    }

    createTexture(options: GpuTextureOptions): GpuTextureHandle {
        const handle = this.nextTexture++ as GpuTextureHandle;
        this.textures.push({
            handle,
            width: options.width,
            height: options.height,
            format: options.format,
            usage: options.usage,
            destroyed: false,
        });
        this.calls.push({ kind: 'create-texture', texture: handle, options });
        return handle;
    }

    createBindGroup(layout: BindGroupLayout, entries: readonly GpuBindGroupEntry[]): GpuBindGroupHandle {
        const handle = this.nextBindGroup++ as GpuBindGroupHandle;
        this.bindGroups.push({ handle, layout, entries });
        this.calls.push({ kind: 'create-bind-group', group: handle, layout, entries });
        return handle;
    }

    createPipeline(descriptor: PipelineDescriptor): GpuPipelineHandle {
        const handle = this.nextPipeline++ as GpuPipelineHandle;
        this.pipelines.push({ handle, descriptor });
        this.calls.push({ kind: 'create-pipeline', pipeline: handle, descriptor });
        return handle;
    }

    beginRenderPass(options: RenderPassOptions): void {
        this.calls.push({ kind: 'begin-render-pass', options });
    }

    setPipeline(pipeline: GpuPipelineHandle): void {
        this.activePipeline = pipeline;
        this.calls.push({ kind: 'set-pipeline', pipeline });
    }

    setBindGroup(index: number, group: GpuBindGroupHandle): void {
        this.boundGroups[index] = group;
        this.calls.push({ kind: 'set-bind-group', index, group });
    }

    draw(count: number, firstInstance: number, instanceCount: number): void {
        this.draws.push({ count, firstInstance, instanceCount });
        this.calls.push({ kind: 'draw', count, firstInstance, instanceCount });
    }

    endRenderPass(): void {
        this.calls.push({ kind: 'end-render-pass' });
    }

    dispatch(workgroupsX: number, workgroupsY: number, workgroupsZ: number): void {
        this.dispatches.push({ workgroupsX, workgroupsY, workgroupsZ });
        this.calls.push({ kind: 'dispatch', workgroupsX, workgroupsY, workgroupsZ });
    }

    destroy(): void {
        this._destroyed = true;
        this.calls.push({ kind: 'destroy' });
    }

    /** The most recently bound pipeline, if any. */
    lastPipeline(): GpuPipelineHandle | undefined {
        return this.activePipeline;
    }

    /** The group bound at an index, if any. */
    boundBindGroup(index: number): GpuBindGroupHandle | undefined {
        return this.boundGroups[index];
    }

    /** The most recent draw command, if any. */
    lastDraw(): DrawRecord | undefined {
        return this.draws[this.draws.length - 1];
    }

    /** The most recent dispatch, if any. */
    lastDispatch(): DispatchRecord | undefined {
        return this.dispatches[this.dispatches.length - 1];
    }

    /** Number of draw commands issued. */
    drawCount(): number {
        return this.draws.length;
    }

    /** Number of compute dispatches issued. */
    dispatchCount(): number {
        return this.dispatches.length;
    }

    /** Number of pipelines created. */
    pipelineCount(): number {
        return this.pipelines.length;
    }

    /** Number of calls recorded. */
    callCount(): number {
        return this.calls.length;
    }
}

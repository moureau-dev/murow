/**
 * The abstract GPU device contract.
 *
 * A device owns buffers, textures, bind groups, and pipelines, and records
 * draw and dispatch commands. Handles are opaque branded numbers, so a backend
 * can map them to its own native objects without leaking API types into shared
 * code. All input and output is plain data.
 */

import type { GpuStruct } from '../schema/struct';
import type { BindGroupLayout } from '../descriptors/bind-group';
import type { PipelineDescriptor } from '../descriptors/pipeline';

declare const gpuBufferBrand: unique symbol;
declare const gpuTextureBrand: unique symbol;
declare const gpuBindGroupBrand: unique symbol;
declare const gpuPipelineBrand: unique symbol;

/** Opaque buffer handle. */
export type GpuBuffer = number & { readonly [gpuBufferBrand]: 'GpuBuffer' };
/** Opaque texture handle. */
export type GpuTexture = number & { readonly [gpuTextureBrand]: 'GpuTexture' };
/** Opaque bind group handle. */
export type GpuBindGroup = number & { readonly [gpuBindGroupBrand]: 'GpuBindGroup' };
/** Opaque pipeline handle. */
export type GpuPipeline = number & { readonly [gpuPipelineBrand]: 'GpuPipeline' };

/** Intended use of a buffer. */
export type BufferUsage = 'uniform' | 'storage' | 'vertex' | 'index';

/** Intended use of a texture. */
export type TextureUsage = 'sample' | 'storage' | 'render-target' | 'copy-src' | 'copy-dst';

/** Create a buffer from a memory schema. Size and usage are derived. */
export interface GpuBufferFromStruct {
    readonly struct: GpuStruct;
}

/** Create a raw buffer of an explicit byte size. */
export interface GpuBufferFromSize {
    readonly size: number;
    readonly usage: BufferUsage;
}

/** Options accepted by `createBuffer`. */
export type GpuBufferOptions = GpuBufferFromStruct | GpuBufferFromSize;

/** Options accepted by `createTexture`. */
export interface GpuTextureOptions {
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly usage: TextureUsage;
}

/** One resource bound into a bind group by name. */
export interface GpuBindGroupEntry {
    readonly name: string;
    readonly resource: unknown;
}

/** A color attachment of a render pass. */
export interface ColorAttachment {
    readonly texture: GpuTexture;
    /** Clear color as `[r, g, b, a]`. Defaults to opaque black. */
    readonly clear?: readonly [number, number, number, number];
    /** Default `'clear'` when a clear color is given, else `'load'`. */
    readonly loadOp?: 'clear' | 'load';
    /** Default `'store'`. */
    readonly storeOp?: 'store' | 'discard';
}

/** A depth attachment of a render pass. */
export interface DepthAttachment {
    readonly texture: GpuTexture;
    /** Clear depth value. Defaults to `1`. */
    readonly clear?: number;
    /** Default `'clear'` when a clear value is given, else `'load'`. */
    readonly loadOp?: 'clear' | 'load';
    /** Default `'store'`. */
    readonly storeOp?: 'store' | 'discard';
}

/** Options accepted by `beginRenderPass`. */
export interface RenderPassOptions {
    /** Optional label for debugging backends. */
    readonly label?: string;
    readonly colorAttachments?: readonly ColorAttachment[];
    readonly depthAttachment?: DepthAttachment;
}

/**
 * A backend-agnostic GPU device. Backends implement this so shared renderer
 * code can be driven against a recorded double in tests.
 */
export interface GpuDevice {
    /** Allocate a buffer. */
    createBuffer(options: GpuBufferOptions): GpuBuffer;

    /** Upload bytes into a buffer at a byte offset. */
    writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView): void;

    /** Release a buffer. */
    destroyBuffer(buffer: GpuBuffer): void;

    /** Allocate a texture. */
    createTexture(options: GpuTextureOptions): GpuTexture;

    /** Bind resources to a layout. */
    createBindGroup(layout: BindGroupLayout, entries: readonly GpuBindGroupEntry[]): GpuBindGroup;

    /** Compile a render pipeline. */
    createPipeline(descriptor: PipelineDescriptor): GpuPipeline;

    /** Begin a render pass. */
    beginRenderPass(options: RenderPassOptions): void;

    /** Bind the active pipeline. */
    setPipeline(pipeline: GpuPipeline): void;

    /** Bind a group at a group index. */
    setBindGroup(index: number, group: GpuBindGroup): void;

    /** Draw instances. */
    draw(count: number, firstInstance: number, instanceCount: number): void;

    /** End the active render pass. */
    endRenderPass(): void;

    /** Dispatch a compute workload. */
    dispatch(workgroupsX: number, workgroupsY: number, workgroupsZ: number): void;

    /** Release every resource owned by the device. */
    destroy(): void;
}

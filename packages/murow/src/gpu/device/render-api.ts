/**
 * Backend-neutral GPU device model.
 *
 * The renderer is written against these interfaces, never against a concrete
 * API. A backend implements them: `murow/webgpu` wraps a `GPUDevice`, another
 * backend wraps whatever its API exposes. Descriptor objects are intentionally
 * open (`any`-shaped) so each backend accepts its own descriptor dialect.
 *
 * Types and small value tables only. No backend, no device.
 */

/** A present/surface context (canvas-backed), created by a backend. */
export type RawCanvasContext = any;

/** A shared buffer source accepted by queue uploads. */
export type RawBufferSource = ArrayBufferLike | ArrayBufferView;

/** Index element format. */
export type RawIndexFormat = 'uint16' | 'uint32';

/** Pixel format spelling (for example `bgra8unorm`). */
export type RawTextureFormat = string;

/** Vertex buffer layout descriptor. */
export type RawVertexBufferLayout = any;
/** Blend component descriptor. */
export type RawBlendComponent = any;
/** Blend state descriptor. */
export type RawBlendState = any;
/** Depth/stencil state descriptor. */
export type RawDepthStencilState = any;
/** Color target state descriptor. */
export type RawColorTargetState = any;
/** Primitive state descriptor. */
export type RawPrimitiveState = any;
/** One bind group entry. */
export type RawBindGroupEntry = any;

/** A GPU buffer. */
export interface RawBuffer {
    readonly size: number;
    readonly usage: number;
    mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
    getMappedRange(offset?: number, size?: number): ArrayBuffer;
    unmap(): void;
    destroy(): void;
}

/** A texture view. */
export interface RawTextureView {
    readonly __textureView?: never;
}

/** A texture. */
export interface RawTexture {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers?: number;
    createView(descriptor?: any): RawTextureView;
    destroy(): void;
}

/** A sampler. */
export interface RawSampler {
    readonly __sampler?: never;
}

/** A shader module. */
export interface RawShaderModule {
    readonly __shaderModule?: never;
}

/** A bind group layout. */
export interface RawBindGroupLayout {
    readonly __bindGroupLayout?: never;
}

/** A pipeline layout. */
export interface RawPipelineLayout {
    readonly __pipelineLayout?: never;
}

/** A bind group. */
export interface RawBindGroup {
    readonly __bindGroup?: never;
}

/** A render pipeline. */
export interface RawRenderPipeline {
    getBindGroupLayout(index: number): RawBindGroupLayout;
    readonly __renderPipeline?: never;
}

/** A compute pipeline. */
export interface RawComputePipeline {
    getBindGroupLayout(index: number): RawBindGroupLayout;
    readonly __computePipeline?: never;
}

/** A command buffer produced by an encoder. */
export interface RawCommandBuffer {
    readonly __commandBuffer?: never;
}

/** A queue that accepts uploads and submissions. */
export interface RawQueue {
    writeBuffer(buffer: RawBuffer, offset: number, data: RawBufferSource, dataOffset?: number, size?: number): void;
    writeTexture(destination: any, data: RawBufferSource, layout: any, size?: any): void;
    copyExternalImageToTexture(source: any, destination: any, size?: any): void;
    submit(commandBuffers: readonly RawCommandBuffer[]): void;
}

/** A render pass encoder. */
export interface RawRenderPassEncoder {
    setPipeline(pipeline: RawRenderPipeline): void;
    setBindGroup(index: number, group: RawBindGroup, dynamicOffsets?: readonly number[]): void;
    setVertexBuffer(slot: number, buffer: RawBuffer, offset?: number, size?: number): void;
    setIndexBuffer(buffer: RawBuffer, format: RawIndexFormat, offset?: number, size?: number): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
    drawIndirect(indirectBuffer: RawBuffer, indirectOffset: number): void;
    drawIndexedIndirect(indirectBuffer: RawBuffer, indirectOffset: number): void;
    setViewport?(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
    setScissorRect?(x: number, y: number, width: number, height: number): void;
    end(): void;
}

/** A compute pass encoder. */
export interface RawComputePassEncoder {
    setPipeline(pipeline: RawComputePipeline): void;
    setBindGroup(index: number, group: RawBindGroup, dynamicOffsets?: readonly number[]): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    dispatchWorkgroupsIndirect(indirectBuffer: RawBuffer, indirectOffset: number): void;
    end(): void;
}

/** A command encoder. */
export interface RawCommandEncoder {
    beginRenderPass(descriptor: any): RawRenderPassEncoder;
    beginComputePass(descriptor?: any): RawComputePassEncoder;
    copyBufferToBuffer(source: RawBuffer, sourceOffset: number, destination: RawBuffer, destinationOffset: number, size: number): void;
    copyBufferToTexture(source: any, destination: any, copySize: any): void;
    copyTextureToBuffer(source: any, destination: any, copySize: any): void;
    copyTextureToTexture(source: any, destination: any, copySize: any): void;
    finish(): RawCommandBuffer;
}

/** The device model the renderer drives. */
export interface RawDevice {
    createBuffer(descriptor: any): RawBuffer;
    createTexture(descriptor: any): RawTexture;
    createSampler(descriptor?: any): RawSampler;
    createShaderModule(descriptor: any): RawShaderModule;
    createBindGroupLayout(descriptor: any): RawBindGroupLayout;
    createPipelineLayout(descriptor: any): RawPipelineLayout;
    createBindGroup(descriptor: any): RawBindGroup;
    createRenderPipeline(descriptor: any): RawRenderPipeline;
    createComputePipeline(descriptor: any): RawComputePipeline;
    createCommandEncoder(descriptor?: any): RawCommandEncoder;
    readonly queue: RawQueue;
    readonly limits: any;
    readonly features: any;
    readonly lost?: Promise<unknown>;
    destroy(): void;
}

/** Buffer usage flags. */
export const RawBufferUsage = {
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
} as const;

/** Texture usage flags. */
export const RawTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
} as const;

/** Shader stage flags. */
export const RawShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
} as const;

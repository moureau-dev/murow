import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';
import type { SpriteDataLayout, SpriteTextureLayout } from '../internals/sprite-shader';
import type { CameraManager2D } from '../../camera/2d';

/**
 * Renderer2DCore holds the shared GPU resources and frame state that every 2D
 * manager and the composition root read. It carries no peer managers, so it
 * cannot become a service locator.
 */
export class Renderer2DCore {
    root!: { device: RawDevice };
    device!: RawDevice;
    context!: RawCanvasContext;
    format!: RawTextureFormat;

    /** The shared camera facade. `renderer.camera` returns this instance. */
    camera!: CameraManager2D;

    /** Bind group layouts for the sprite data and the sprite texture. */
    spriteLayout!: SpriteDataLayout;
    textureLayout!: SpriteTextureLayout;
    rawTextureLayout!: RawBindGroupLayout;

    /** The sprite render pipeline and its per-frame data bind group. */
    rawPipeline!: RawRenderPipeline;
    rawSpriteBindGroup!: RawBindGroup;

    /** Raw buffers unwrapped from TypeGPU for batched rendering. */
    rawDynamicBuffer!: RawBuffer;
    rawStaticBuffer!: RawBuffer;
    rawUniformBuffer!: RawBuffer;
    rawSlotIndexBuffer!: RawBuffer;

    /** TypeGPU buffer handles, kept so `destroy` can release them. */

    /** Shared uniform block: mat3 padded to 12 floats, plus alpha and resolution. */
    readonly uniformData = new Float32Array(20);

    /** Render target size in physical pixels. */
    width = 1;
    height = 1;
}

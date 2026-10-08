import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import type { SpriteDataLayout, SpriteTextureLayout } from '../internals/sprite-shader';
import type { CameraManager2D } from '../managers/camera';

/**
 * Renderer2DCore holds the shared GPU resources and frame state that every 2D
 * manager and the composition root read. It carries no peer managers, so it
 * cannot become a service locator.
 */
export class Renderer2DCore {
    root!: TgpuRoot;
    device!: GPUDevice;
    context!: GPUCanvasContext;
    format!: GPUTextureFormat;

    /** The shared camera facade. `renderer.camera` returns this instance. */
    camera!: CameraManager2D;

    /** Bind group layouts for the sprite data and the sprite texture. */
    spriteLayout!: SpriteDataLayout;
    textureLayout!: SpriteTextureLayout;
    rawTextureLayout!: GPUBindGroupLayout;

    /** The sprite render pipeline and its per-frame data bind group. */
    rawPipeline!: GPURenderPipeline;
    rawSpriteBindGroup!: GPUBindGroup;

    /** Raw buffers unwrapped from TypeGPU for batched rendering. */
    rawDynamicBuffer!: GPUBuffer;
    rawStaticBuffer!: GPUBuffer;
    rawUniformBuffer!: GPUBuffer;
    rawSlotIndexBuffer!: GPUBuffer;

    /** TypeGPU buffer handles, kept so `destroy` can release them. */
    dynamicBuffer!: TgpuBuffer<any>;
    staticBuffer!: TgpuBuffer<any>;
    uniformBuffer!: TgpuBuffer<any>;
    slotIndexBuffer!: TgpuBuffer<any>;

    /** Shared uniform block: mat3 padded to 12 floats, plus alpha and resolution. */
    readonly uniformData = new Float32Array(20);

    /** Render target size in physical pixels. */
    width = 1;
    height = 1;
}

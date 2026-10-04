import type { CameraEffect } from '../../../camera/camera-3d';
import { CAMERA_EFFECT_WGSL } from './shaders';

/** Max effects per frame; also sizes the dynamic uniform buffer. */
const MAX_EFFECTS = 16;
/** Uniform slot stride, aligned to the WebGPU min uniform offset alignment. */
const SLOT = 256;
const SLOT_FLOATS = SLOT / 4;

/**
 * Owns the off-screen targets, fullscreen pipeline, and per-effect uniform slots
 * for `camera.effects`. The renderer draws the scene into `sceneTarget()` and then
 * calls `apply()`, which runs one fullscreen pass per effect into off-screen
 * targets and presents the result to the swapchain.
 *
 * Each effect pass reads a distinct slot of the uniform buffer via a dynamic
 * offset. This matters: `queue.writeBuffer` writes are not interleaved with
 * command execution, so a single shared slot would leave every pass reading the
 * last value written.
 *
 * A persistent `history` target backs temporal effects (`motionBlur`); it is
 * copied from the scene on the first frame and refreshed by the blur pass.
 */
export class CameraEffectStack {
    private readonly format: GPUTextureFormat;
    private readonly layout: GPUBindGroupLayout;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly uniformBuffer: GPUBuffer;
    private readonly staging = new Float32Array((MAX_EFFECTS + 2) * SLOT_FLOATS);
    private readonly stagingU32 = new Uint32Array(this.staging.buffer);
    private texA: GPUTexture | null = null;
    private texB: GPUTexture | null = null;
    private viewA: GPUTextureView | null = null;
    private viewB: GPUTextureView | null = null;
    private bindA: GPUBindGroup | null = null;
    private bindB: GPUBindGroup | null = null;
    private history: GPUTexture | null = null;
    private historyView: GPUTextureView | null = null;
    private historyValid = false;
    private targetW = 0;
    private targetH = 0;

    constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
        this.format = format;
        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this.layout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            ],
        });
        const module = device.createShaderModule({ code: CAMERA_EFFECT_WGSL, label: 'camera-effects' });
        this.pipeline = device.createRenderPipeline({
            label: 'camera-effects',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
            vertex: { module },
            fragment: { module, targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        this.uniformBuffer = device.createBuffer({
            size: (MAX_EFFECTS + 2) * SLOT,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    /** The off-screen target the scene should render into (created/resized on demand). */
    sceneTarget(width: number, height: number): GPUTextureView {
        this.ensureTargets(width, height);
        return this.viewA!;
    }

    /** Run the effect chain from the scene target, presenting the result to `present`. */
    apply(
        encoder: GPUCommandEncoder,
        present: GPUTextureView,
        effects: readonly CameraEffect[],
        time: number,
        width: number,
        height: number,
    ): void {
        const count = Math.min(effects.length, MAX_EFFECTS);

        // Seed temporal history with the current frame the first time only.
        if (!this.historyValid && this.texA && this.history) {
            encoder.copyTextureToTexture(
                { texture: this.texA },
                { texture: this.history },
                [this.targetW, this.targetH, 1],
            );
            this.historyValid = true;
        }

        // Pack every effect (and the present pass) into its own slot, then upload once.
        for (let i = 0; i < count; i++) this.packEffect(effects[i]!, i, time, width, height);
        const presentSlot = count;
        this.packPresent(presentSlot);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.staging.buffer, 0, (presentSlot + 1) * SLOT);

        let srcIsA = true;
        for (let i = 0; i < count; i++) {
            const dstIsB = srcIsA;
            const dst = dstIsB ? this.viewB! : this.viewA!;
            this.fullscreenPass(encoder, srcIsA ? this.bindA! : this.bindB!, dst, i * SLOT);
            if (effects[i]!.type === 'motionBlur' && this.history) {
                encoder.copyTextureToTexture(
                    { texture: dstIsB ? this.texB! : this.texA! },
                    { texture: this.history },
                    [this.targetW, this.targetH, 1],
                );
            }
            srcIsA = !srcIsA;
        }

        // Present the final off-screen result with an identity pass.
        this.fullscreenPass(encoder, srcIsA ? this.bindA! : this.bindB!, present, presentSlot * SLOT);
    }

    destroy(): void {
        this.texA?.destroy();
        this.texB?.destroy();
        this.history?.destroy();
        this.uniformBuffer.destroy();
    }

    private fullscreenPass(encoder: GPUCommandEncoder, bind: GPUBindGroup, target: GPUTextureView, offset: number): void {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bind, [offset]);
        pass.draw(3);
        pass.end();
    }

    private ensureTargets(width: number, height: number): void {
        const w = Math.max(1, width);
        const h = Math.max(1, height);
        if (this.texA && this.targetW === w && this.targetH === h) return;

        this.texA?.destroy();
        this.texB?.destroy();
        this.history?.destroy();
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
        const make = () => this.device.createTexture({ size: [w, h, 1], format: this.format, usage });
        this.texA = make();
        this.texB = make();
        this.history = this.device.createTexture({
            size: [w, h, 1],
            format: this.format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.viewA = this.texA.createView();
        this.viewB = this.texB.createView();
        this.historyView = this.history.createView();
        this.historyValid = false;

        const bind = (view: GPUTextureView) => this.device.createBindGroup({
            layout: this.layout,
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.uniformBuffer, offset: 0, size: 32 } },
                { binding: 3, resource: this.historyView! },
            ],
        });
        this.bindA = bind(this.viewA);
        this.bindB = bind(this.viewB);
        this.targetW = w;
        this.targetH = h;
    }

    /** Pack one effect into slot `index` of the staging buffer. */
    private packEffect(effect: CameraEffect, index: number, time: number, width: number, height: number): void {
        const base = index * SLOT_FLOATS;
        const f = this.staging;
        f[base] = 0; f[base + 1] = 0; f[base + 2] = 0; f[base + 3] = 0;
        f[base + 4] = time;
        f[base + 5] = width;
        f[base + 6] = height;
        let kind = 0;
        switch (effect.type) {
            case 'vignette':
                kind = 0; f[base] = effect.strength ?? 0.4; f[base + 1] = effect.inner ?? 0.3; f[base + 2] = effect.outer ?? 0.85; break;
            case 'grade':
                kind = 1; f[base] = effect.saturation ?? 1; f[base + 1] = effect.contrast ?? 1; f[base + 2] = effect.brightness ?? 0; break;
            case 'grayscale':
                kind = 2; break;
            case 'chromatic':
                kind = 3; f[base] = effect.amount ?? 1; break;
            case 'scanlines':
                kind = 4; f[base] = effect.intensity ?? 0.3; f[base + 1] = effect.frequency ?? 120; f[base + 2] = effect.speed ?? 3; break;
            case 'posterize':
                kind = 5; f[base] = effect.levels ?? 6; break;
            case 'motionBlur':
                kind = 6; f[base] = effect.feedback ?? 0.82; break;
        }
        this.stagingU32[base + 7] = kind;
    }

    /** Pack the identity present pass into slot `index`. */
    private packPresent(index: number): void {
        const base = index * SLOT_FLOATS;
        this.staging[base] = 0; this.staging[base + 1] = 0;
        this.staging[base + 2] = 0; this.staging[base + 3] = 0;
        this.stagingU32[base + 7] = 7;
    }
}

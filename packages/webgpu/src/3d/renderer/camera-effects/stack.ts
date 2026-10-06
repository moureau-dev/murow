import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import type { AnyWgslData } from 'typegpu/data';
import { tgpu, d, std } from '../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import type { CameraEffect, CameraEffectList } from '../../../camera/camera-effect';
import { CAMERA_EFFECT_WGSL, EFFECT_SCENE_UNIFORMS } from './shaders';

/** Uniform slot stride, aligned to the WebGPU min uniform offset alignment. */
const SLOT = 256;
const SLOT_FLOATS = SLOT / 4;

interface CompiledCustomEffect {
    pipeline: GPURenderPipeline;
    layout: any;
    buffer: TgpuBuffer<any>;
    schema: Record<string, AnyWgslData>;
    bindA: GPUBindGroup | null;
    bindB: GPUBindGroup | null;
    write(): void;
}

/**
 * Owns the off-screen targets, fullscreen pipelines, and effect uniforms for
 * `camera.effects`. The renderer draws the scene into `sceneTarget()` and then
 * calls `apply()`, which runs one fullscreen pass per effect into off-screen
 * targets and presents the result to the swapchain.
 *
 * Built-in effects share one raw-WGSL pipeline and read a distinct slot of a
 * dynamic uniform buffer. Custom (`shader`) effects compile a declarative
 * fragment against an engine fullscreen vertex and own their own pipeline and
 * uniform buffer. Timing matters: `queue.writeBuffer` writes are not interleaved
 * with command execution, so each pass must read a distinct slot.
 *
 * A persistent `history` target backs temporal effects (`motionBlur`); it is
 * copied from the scene on the first frame and refreshed by the blur pass.
 */
export interface CameraEffectStackOptions {
    /** TypeGPU root, used to compile custom effects. */
    root: TgpuRoot;
    /** The canvas color format that effect passes target. */
    format: GPUTextureFormat;
    /** Chain capacity; sizes the uniform buffer and compiled-effect table. Default 20. */
    maxEffects?: number;
}

export class CameraEffectStack {
    private readonly root: TgpuRoot;
    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly layout: GPUBindGroupLayout;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly uniformBuffer: GPUBuffer;
    private readonly sceneBuffer: GPUBuffer;
    private readonly maxEffects: number;
    private readonly sceneData = new Float32Array(4);
    private readonly staging: Float32Array;
    private readonly stagingU32: Uint32Array;
    /** Compiled custom effects, indexed by `CameraEffect.id` (bounded slot). */
    private readonly customs: ({ effect: CameraEffect; compiled: CompiledCustomEffect } | null)[];
    private fullscreenVertex: unknown = null;
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
    private depthView: GPUTextureView;
    private depthSampler: GPUSampler;
    private readonly fallbackDepth: GPUTexture;
    private near = 0.1;
    private far = 1000;

    /**
     * @param options Stack options. `root` is the TypeGPU root used to compile
     * custom effects; `format` is the target canvas color format; `maxEffects`
     * sizes the uniform buffer, per-effect slots, and compiled-effect table.
     */
    constructor({ root, format, maxEffects = 20 }: CameraEffectStackOptions) {
        this.root = root;
        this.device = root.device;
        this.format = format;
        this.maxEffects = maxEffects;
        this.staging = new Float32Array((maxEffects + 2) * SLOT_FLOATS);
        this.stagingU32 = new Uint32Array(this.staging.buffer);
        this.customs = new Array(maxEffects).fill(null);
        this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this.layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
            ],
        });
        this.depthSampler = this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        this.fallbackDepth = this.device.createTexture({
            size: [1, 1, 1], format: 'depth24plus', usage: GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthView = this.fallbackDepth.createView();
        const module = this.device.createShaderModule({ code: CAMERA_EFFECT_WGSL, label: 'camera-effects' });
        this.pipeline = this.device.createRenderPipeline({
            label: 'camera-effects',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
            vertex: { module },
            fragment: { module, targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        this.uniformBuffer = this.device.createBuffer({
            size: (this.maxEffects + 2) * SLOT,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.sceneBuffer = this.device.createBuffer({
            size: 16,
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
        effects: CameraEffectList,
        time: number,
        width: number,
        height: number,
    ): void {
        // Seed temporal history with the current frame the first time only.
        if (!this.historyValid && this.texA && this.history) {
            encoder.copyTextureToTexture(
                { texture: this.texA },
                { texture: this.history },
                [this.targetW, this.targetH, 1],
            );
            this.historyValid = true;
        }

        // Compile any new custom effects, and refresh the shared scene uniforms.
        let hasCustom = false;
        for (let i = 0; i < effects.count; i++) {
            const effect = effects.at(i);
            if (!effect.enabled || effect.type !== 'shader') continue;
            hasCustom = true;
            const id = effect.id;
            if (id < 0 || id >= this.customs.length) continue;
            const existing = this.customs[id];
            if (existing && existing.effect === effect) continue;
            if (existing) existing.compiled.buffer.destroy();
            this.customs[id] = { effect, compiled: this.compileCustom(effect) };
        }
        if (hasCustom) {
            this.sceneData[0] = time;
            this.sceneData[1] = width;
            this.sceneData[2] = height;
            this.sceneData[3] = 0;
            this.device.queue.writeBuffer(this.sceneBuffer, 0, this.sceneData);
        }

        // Pack built-in effects (and the present pass) into their uniform slots.
        let enabled = 0;
        for (let i = 0; i < effects.count && enabled < this.maxEffects; i++) {
            const effect = effects.at(i);
            if (!effect.enabled) continue;
            if (effect.type !== 'shader') this.packEffect(effect, enabled, time, width, height);
            enabled++;
        }
        this.packPresent(enabled);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.staging.buffer, 0, (enabled + 1) * SLOT);

        let srcIsA = true;
        let slot = 0;
        for (let i = 0; i < effects.count && slot < this.maxEffects; i++) {
            const effect = effects.at(i);
            if (!effect.enabled) continue;
            const dstIsB = srcIsA;
            const dst = dstIsB ? this.viewB! : this.viewA!;
            if (effect.type === 'shader') {
                const compiled = this.findCustom(effect)!;
                compiled.write();
                this.pass(encoder, compiled.pipeline, srcIsA ? compiled.bindA! : compiled.bindB!, dst, null);
            } else {
                this.pass(encoder, this.pipeline, srcIsA ? this.bindA! : this.bindB!, dst, slot * SLOT);
                if (effect.type === 'motionBlur' && this.history) {
                    encoder.copyTextureToTexture(
                        { texture: dstIsB ? this.texB! : this.texA! },
                        { texture: this.history },
                        [this.targetW, this.targetH, 1],
                    );
                }
            }
            srcIsA = !srcIsA;
            slot++;
        }

        // Present the final off-screen result with an identity pass.
        this.pass(encoder, this.pipeline, srcIsA ? this.bindA! : this.bindB!, present, enabled * SLOT);
    }

    private findCustom(effect: CameraEffect): CompiledCustomEffect | null {
        const id = effect.id;
        if (id < 0 || id >= this.customs.length) return null;
        const entry = this.customs[id];
        return entry && entry.effect === effect ? entry.compiled : null;
    }

    destroy(): void {
        this.texA?.destroy();
        this.texB?.destroy();
        this.history?.destroy();
        this.uniformBuffer.destroy();
        this.sceneBuffer.destroy();
        for (let i = 0; i < this.customs.length; i++) {
            const entry = this.customs[i];
            if (entry) {
                entry.compiled.buffer.destroy();
                this.customs[i] = null;
            }
        }
    }

    /** Draw one fullscreen triangle. `offset` is null for layouts without a dynamic buffer. */
    private pass(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bind: GPUBindGroup, target: GPUTextureView, offset: number | null): void {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
        });
        pass.setPipeline(pipeline);
        if (offset === null) pass.setBindGroup(0, bind);
        else pass.setBindGroup(0, bind, [offset]);
        pass.draw(3);
        pass.end();
    }

    /**
     * Bind the scene depth texture for depth-based effects (e.g. `fog`), plus
     * the camera near/far used to linearise it. Call on init and after resize.
     */
    setDepth(view: GPUTextureView, sampler: GPUSampler, near: number, far: number): void {
        this.depthView = view;
        this.depthSampler = sampler;
        this.near = near;
        this.far = far;
        if (this.viewA && this.viewB) this.rebuildBuiltins();
    }

    private rebuildBuiltins(): void {
        if (!this.viewA || !this.viewB || !this.historyView) return;
        const bind = (view: GPUTextureView) => this.device.createBindGroup({
            layout: this.layout,
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.uniformBuffer, offset: 0, size: 48 } },
                { binding: 3, resource: this.historyView! },
                { binding: 4, resource: this.depthView },
                { binding: 5, resource: this.depthSampler },
            ],
        });
        this.bindA = bind(this.viewA);
        this.bindB = bind(this.viewB);
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

        this.rebuildBuiltins();
        for (let i = 0; i < this.customs.length; i++) {
            const entry = this.customs[i];
            if (entry) this.rebindCustom(entry.compiled);
        }
        this.targetW = w;
        this.targetH = h;
    }

    // --- Custom effects ---

    private compileCustom(effect: CameraEffect): CompiledCustomEffect {
        const schema: Record<string, AnyWgslData> = effect.uniforms && Object.keys(effect.uniforms).length > 0
            ? effect.uniforms
            : { _unused: d.f32 };
        const Struct = d.struct(schema);
        const layout = tgpu.bindGroupLayout({
            material: { uniform: Struct },
            scene: { uniform: EFFECT_SCENE_UNIFORMS },
            src: { texture: 'float' },
            sampler: { sampler: 'filtering' },
            history: { texture: 'float' },
        });
        const fragmentFn = effect.fragment!;
        attachShaderMetadata(
            fragmentFn as any,
            () => {
                const ext: Record<string, unknown> = { d, std };
                // Texture views are only accessible during codegen; outside it
                // these reads throw and TypeGPU re-invokes the getter in codegen
                // mode. Mirror the material library's guarded pattern.
                try {
                    ext.textures = { src: (layout as any).$.src, sampler: (layout as any).$.sampler };
                    ext.material = (layout as any).$.material;
                    ext.scene = (layout as any).$.scene;
                    ext.history = (layout as any).$.history;
                } catch { /* outside shader codegen */ }
                return ext;
            },
            false,
            { d, std },
        );
        const fragment = tgpu.fragmentFn({ in: { vUV: d.vec2f }, out: d.vec4f } as any)(fragmentFn as any);
        if (!this.fullscreenVertex) this.fullscreenVertex = this.createFullscreenVertex();
        const { code } = tgpu.resolveWithContext([this.fullscreenVertex as any, fragment as any]);
        const module = this.device.createShaderModule({ code, label: 'camera-effect-custom' });
        const pipeline = this.device.createRenderPipeline({
            label: 'camera-effect-custom',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.root.unwrap(layout) as unknown as GPUBindGroupLayout] }),
            vertex: { module },
            fragment: { module, targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list' },
        });
        const buffer = this.root.createBuffer(Struct).$usage('uniform');
        const keys = Object.keys(schema);
        const mirror: Record<string, unknown> = {};
        const compiled: CompiledCustomEffect = {
            pipeline,
            layout,
            buffer,
            schema,
            bindA: null,
            bindB: null,
            write: () => {
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i]!;
                    mirror[key] = coerceUniform(schema[key]!, effect.params?.[key] ?? zeroValue(schema[key]!));
                }
                buffer.write(mirror as never);
            },
        };
        this.rebindCustom(compiled);
        return compiled;
    }

    private rebindCustom(compiled: CompiledCustomEffect): void {
        if (!this.viewA || !this.viewB || !this.historyView) return;
        const rawLayout = this.root.unwrap(compiled.layout) as unknown as GPUBindGroupLayout;
        const rawMaterial = this.root.unwrap(compiled.buffer) as unknown as GPUBuffer;
        const bind = (view: GPUTextureView) => this.device.createBindGroup({
            layout: rawLayout,
            entries: [
                { binding: 0, resource: { buffer: rawMaterial } },
                { binding: 1, resource: { buffer: this.sceneBuffer } },
                { binding: 2, resource: view },
                { binding: 3, resource: this.sampler },
                { binding: 4, resource: this.historyView! },
            ],
        });
        compiled.bindA = bind(this.viewA);
        compiled.bindB = bind(this.viewB);
    }

    private createFullscreenVertex(): unknown {
        const fn = function(input: { vertexIndex: number }) {
            const fi = d.f32(input.vertexIndex);
            // Fullscreen triangle: i=0 -> (-1,-1), i=1 -> (3,-1), i=2 -> (-1,3).
            const x = -1.0 + 4.0 * std.step(1.0, fi) * (1.0 - std.step(2.0, fi));
            const y = -1.0 + 4.0 * std.step(2.0, fi);
            return { pos: d.vec4f(x, y, 0.0, 1.0), vUV: d.vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5) };
        };
        attachShaderMetadata(fn as any, () => ({ d, std }), false, { d, std });
        return tgpu.vertexFn({
            in: { vertexIndex: d.builtin.vertexIndex },
            out: { pos: d.builtin.position, vUV: d.vec2f },
        } as any)(fn as any);
    }

    // --- Built-in effects ---

    /** Pack one built-in effect into slot `index` of the staging buffer. */
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
            case 'fxaa':
                kind = 8; break;
            case 'fog': {
                kind = 9;
                const c = effect.color ?? [0.5, 0.6, 0.7];
                f[base] = c[0]; f[base + 1] = c[1]; f[base + 2] = c[2];
                f[base + 3] = effect.density ?? 0.02;
                break;
            }
        }
        f[base + 8] = this.near;
        f[base + 9] = this.far;
        this.stagingU32[base + 7] = kind;
    }

    /** Pack the identity present pass into slot `index`. */
    private packPresent(index: number): void {
        const base = index * SLOT_FLOATS;
        this.staging[base] = 0; this.staging[base + 1] = 0;
        this.staging[base + 2] = 0; this.staging[base + 3] = 0;
        this.staging[base + 8] = this.near;
        this.staging[base + 9] = this.far;
        this.stagingU32[base + 7] = 7;
    }
}

function coerceUniform(type: AnyWgslData, value: unknown): unknown {
    if (Array.isArray(value)) {
        const a = value as number[];
        if (type === (d.vec2f as unknown)) return d.vec2f(a[0]!, a[1]!);
        if (type === (d.vec3f as unknown)) return d.vec3f(a[0]!, a[1]!, a[2]!);
        if (type === (d.vec4f as unknown)) return d.vec4f(a[0]!, a[1]!, a[2]!, a[3]!);
    }
    return value;
}

function zeroValue(type: AnyWgslData): unknown {
    if (type === (d.vec2f as unknown)) return [0, 0];
    if (type === (d.vec3f as unknown)) return [0, 0, 0];
    if (type === (d.vec4f as unknown)) return [0, 0, 0, 0];
    return 0;
}

/**
 * WebGPU2DRenderer — instanced 2D sprite renderer backed by TypeGPU.
 *
 * - One draw call per spritesheet batch (layer-sorted)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation between ticks
 * - TypeGPU for shaders, layouts, pipelines; raw device for hot-path uploads
 *
 * The renderer is a composition root: it owns resource setup, lifecycle and the
 * render sequence. User-facing subsystems are reached through managers
 * (`renderer.sprites`, `renderer.sheets`, `renderer.geometry`,
 * `renderer.compute`), and the camera is `renderer.camera`.
 */

import type { RawDevice, RawTextureFormat } from 'murow/gpu';
import { d } from '../../gpu';
import { runtime } from '../runtime';
import type { RendererRuntime } from 'murow/renderer/managers';
import { RendererManagers2D } from 'murow/renderer/managers';
import { Renderer2DCore, CameraEffectStack, DynamicSprite, StaticSprite, SpriteUniforms, createSpriteLayout, createTextureLayout, createSpriteVertex, createSpriteFragment, Raycast2D, RaycastController2D, CameraManager2D, CameraRegistry, applyCamera2DCreateOptions, type Camera2DCreateOptions, SpriteManager, SpritesheetManager, GeometryManager, setPrefab2DHandle } from 'murow/renderer/managers/runtime';
import { BaseRenderer } from 'murow/renderer';
import { LayerRegistry } from 'murow/renderer';
import type {
    AssetBucket,
    Renderer2DOptions,
    PrefabBucket2D,
    SpritesheetPrefab,
} from 'murow/renderer';
import { Logger } from 'murow/core';

export interface WebGPU2DRendererOptions<A extends AssetBucket<'2d', any, any> = AssetBucket<'2d', any, any>> extends Renderer2DOptions {
    /**
     * Pre-loaded asset bucket. When provided, the renderer uploads every
     * spritesheet prefab to the GPU during `init()`, and
     * `sprites.add({ sheet: assets.prefabs.get('id') })` resolves to the right
     * spritesheet handle. The bucket must have `load()` resolved before being
     * passed in.
     */
    assets?: A;
    /**
     * How many sprite instances you intend to spawn. Used to size buffers when
     * `maxSprites` is not given explicitly. Defaults to 1024.
     */
    maxInstances?: number;
    /**
     * Development diagnostics. `true` routes warnings to the console with a
     * `[murow]` prefix; pass a `Logger` to route them yourself.
     */
    debug?: boolean | Logger;
    /**
     * Capacity of the camera-effect chain. Bounds the number of live effects
     * and the renderer's compiled-effect resources. Default 20.
     */
    maxEffects?: number;
    /** Render layer registry. Defaults to a registry owned by the renderer. */
    layers?: LayerRegistry;
    /** Layer capacity for the default registry. Default 32, maximum 32. */
    maxLayers?: number;
    /** Max registered cameras. Defaults to 4. */
    maxCameras?: number;
    /** Options for the auto-created primary camera. */
    camera?: Camera2DCreateOptions | false;
}

export class WebGPU2DRenderer<A extends AssetBucket<'2d', any, any> = AssetBucket<'2d', any, any>> extends BaseRenderer<Renderer2DOptions> {
    private runtime!: RendererRuntime;
    /** Sprite instance budget. Fixed for the device lifetime. */
    readonly maxSprites: number;

    private readonly core: Renderer2DCore;
    private readonly logger: Logger;
    private readonly _prefabs: PrefabBucket2D | null;
    private readonly maxEffects: number;
    private cameraEffects!: CameraEffectStack;
    private lastRenderTime = 0;
    /** Accumulated render time (seconds), exposed to effects as `scene.time`. */
    private elapsed = 0;

    /** Pooled sprite facade. */
    sprites!: SpriteManager;
    /** Camera registry. `camera` is the primary camera. */
    readonly cameras: CameraRegistry<CameraManager2D, Camera2DCreateOptions>;
    /** Render layer registry. Shared with every manager. */
    readonly layers: LayerRegistry;
    /** Spritesheet upload facade. */
    sheets!: SpritesheetManager;
    /** Custom geometry facade. */
    geometry!: GeometryManager;
    /** 2D picking facade. */
    raycast!: Raycast2D;

    private resizeObserver: ResizeObserver | null = null;
    private readonly resizeCallbacks: ((width: number, height: number) => void)[] = [];

    constructor(canvas: HTMLCanvasElement, options: WebGPU2DRendererOptions<A>) {
        const resolvedMaxSprites = options.maxSprites ?? options.maxInstances ?? 1024;
        super(canvas, { ...options, maxSprites: resolvedMaxSprites });
        this.maxSprites = resolvedMaxSprites;
        this.maxEffects = options.maxEffects ?? 20;
        this.core = new Renderer2DCore();
        this.logger = Logger.resolve(options.debug);
        if (options.layers !== undefined && options.maxLayers !== undefined) {
            this.logger.warn('maxLayers is ignored when layers is provided');
        }
        this.layers = options.layers ?? new LayerRegistry({ capacity: options.maxLayers, logger: this.logger });
        this.cameras = new CameraRegistry<CameraManager2D, Camera2DCreateOptions>(
            options.maxCameras ?? 2,
            (props) => {
                const camera = new CameraManager2D(canvas.width || 800, canvas.height || 600, {
                    maxEffects: props.maxEffects ?? this.maxEffects,
                });
                applyCamera2DCreateOptions(camera, props);
                camera.mask = props.mask === undefined
                    ? this.layers.all
                    : this.layers.resolveMask(props.mask);
                return camera;
            },
            this.logger,
        );
        if (options.camera !== false) this.core.camera = this.cameras.create(options.camera ?? {});
        this.core.width = canvas.width || 1;
        this.core.height = canvas.height || 1;
        this._prefabs = (options.assets?.prefabs as unknown as PrefabBucket2D | undefined) ?? null;
    }

    get device(): RawDevice { return this.core.device; }
    get format(): RawTextureFormat { return this.core.format; }

    /** The primary 2D camera. */
    get camera(): CameraManager2D {
        const primary = this.cameras.primary ?? this.core.camera;
        if (primary === undefined) throw new Error('WebGPU2DRenderer: no primary camera');
        return primary;
    }

    /**
     * Project a 2D world point to canvas CSS pixels (for HTML overlays via
     * `murow/dom`). Writes `[x, y, depth]` into `out` (`z` is ignored in 2D).
     */
    worldToScreen(x: number, y: number, _z: number, out: Float32Array): boolean {
        const cam = this.cameras.primary;
        if (cam === undefined) return false;
        const m = cam.getMatrix();
        const ndcX = m[0]! * x + m[4]! * y + m[8]!;
        const ndcY = m[1]! * x + m[5]! * y + m[9]!;
        const w = this.canvas.clientWidth || this._width;
        const h = this.canvas.clientHeight || this._height;
        out[0] = (ndcX * 0.5 + 0.5) * w;
        out[1] = (0.5 - ndcY * 0.5) * h;
        out[2] = 1 / Math.max(cam.zoom, 1e-4);
        return true;
    }

    async init(): Promise<void> {
        const primary = this.cameras.primary;
        if (primary !== undefined) this.core.camera = primary;

        this.runtime = runtime();
        const presentation = await this.runtime.createPresentation(this.canvas);
        this.core.root = { device: presentation.device } as never;
        this.core.device = presentation.device;
        const device: any = this.core.device;
        this.core.format = presentation.format;

        this.core.context = presentation.context;
        this.core.context.configure({
            device: this.core.device,
            format: this.core.format,
            alphaMode: 'premultiplied',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.core.width = this._width;
        this.core.height = this._height;
        this.cameras.primary?.setViewport(this._width, this._height);

        // TypeGPU layouts
        this.core.spriteLayout = createSpriteLayout(this.maxSprites);
        this.core.textureLayout = createTextureLayout();

        // TypeGPU shaders
        const vertex = createSpriteVertex(this.core.spriteLayout, this.core.textureLayout);
        const fragment = createSpriteFragment(this.core.spriteLayout, this.core.textureLayout);

        // Render pipeline (no vertex buffer — quad generated from vertexIndex)
        const { code } = this.runtime.compile([vertex, fragment]);
        const spriteModule = device.createShaderModule({ code, label: 'sprite-2d' });
        const spriteBgl = this.runtime.createBindGroupLayout(this.core.spriteLayout.toDescriptor());
        this.core.rawTextureLayout = this.runtime.createBindGroupLayout(this.core.textureLayout.toDescriptor());
        this.core.rawPipeline = device.createRenderPipeline({
            label: 'sprite-2d',
            layout: device.createPipelineLayout({ bindGroupLayouts: [spriteBgl, this.core.rawTextureLayout] }),
            vertex: { module: spriteModule },
            fragment: {
                module: spriteModule,
                targets: [{
                    format: this.core.format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // Instance data buffers
        this.core.rawDynamicBuffer = this.runtime.createRawBuffer(d.arrayOf(DynamicSprite, this.maxSprites), 'storage');
        this.core.rawStaticBuffer = this.runtime.createRawBuffer(d.arrayOf(StaticSprite, this.maxSprites), 'storage');
        this.core.rawUniformBuffer = this.runtime.createRawBuffer(SpriteUniforms, 'uniform');
        this.core.rawSlotIndexBuffer = this.runtime.createRawBuffer(d.arrayOf(d.u32, this.maxSprites), 'storage');

        // Bind group for sprite data
        this.core.rawSpriteBindGroup = device.createBindGroup({
            layout: spriteBgl,
            entries: [
                { binding: 0, resource: { buffer: this.core.rawUniformBuffer } },
                { binding: 1, resource: { buffer: this.core.rawDynamicBuffer } },
                { binding: 2, resource: { buffer: this.core.rawStaticBuffer } },
                { binding: 3, resource: { buffer: this.core.rawSlotIndexBuffer } },
            ],
        });

        // Managers
        const managers = new RendererManagers2D({
            core: this.core,
            runtime: this.runtime,
            canvas: this.canvas,
            logger: this.logger,
            camera: this.cameras.primary,
            maxSprites: this.maxSprites,
            prefabs: this._prefabs,
            layers: this.layers,
            getClearColor: () => this._clearColor,
        });
        this.sheets = managers.sheets;
        this.sprites = managers.sprites;
        this.geometry = managers.geometry;
        this.cameraEffects = new CameraEffectStack({
            runtime: this.runtime,
            root: this.core.root,
            format: this.core.format,
            maxEffects: this.maxEffects,
        });

        if (this._prefabs) {
            this.uploadPrefabBucket(this._prefabs);
        }

        this.raycast = new Raycast2D(new RaycastController2D({
            camera: () => this.cameras.primary,
            eachSprite: this.sprites.eachSprite.bind(this.sprites),
            resolveHitbox: this.sprites.resolveHitbox.bind(this.sprites),
            layerOf: this.sprites.layerOf.bind(this.sprites),
        }), this.canvas);

        this.setupResizeObserver();
        this._initialized = true;
    }

    /**
     * Upload every prefab in the bucket to the GPU and stash the resulting
     * SpritesheetHandle on each prefab so `bucket.get(id)` returns something
     * usable as a sprite source.
     */
    private uploadPrefabBucket(bucket: PrefabBucket2D): void {
        for (const prefab of bucket.entries()) {
            if (prefab.type === 'spritesheet') {
                const handle = this.sheets.upload((prefab as SpritesheetPrefab).parsed);
                setPrefab2DHandle(prefab, handle);
            }
        }
    }

    private setupResizeObserver(): void {
        const supportsDevicePixelBox = (() => {
            try {
                // Throws on unsupported browsers (e.g. iOS Safari)
                const ro = new ResizeObserver(() => {});
                ro.observe(document.body, { box: 'device-pixel-content-box' });
                ro.disconnect();
                return true;
            } catch {
                return false;
            }
        })();

        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                let w: number, h: number;
                if (supportsDevicePixelBox && entry.devicePixelContentBoxSize?.[0]) {
                    w = entry.devicePixelContentBoxSize[0].inlineSize;
                    h = entry.devicePixelContentBoxSize[0].blockSize;
                } else {
                    const box = entry.contentBoxSize[0];
                    const dpr = devicePixelRatio;
                    w = Math.round(box.inlineSize * dpr);
                    h = Math.round(box.blockSize * dpr);
                }
                if (w === this._width && h === this._height) continue;
                this._width = w;
                this._height = h;
                this.core.width = w;
                this.core.height = h;

                if (this.options.autoResize) {
                    this.canvas.width = w;
                    this.canvas.height = h;
                    this.core.context.configure({
                        device: this.core.device,
                        format: this.core.format,
                        alphaMode: 'premultiplied',
                    });
                }

                this.cameras.primary?.setViewport(w, h);

                for (const cb of this.resizeCallbacks) {
                    cb(w, h);
                }
            }
        });
        this.resizeObserver.observe(this.canvas, supportsDevicePixelBox ? { box: 'device-pixel-content-box' } : undefined);
    }

    /**
     * Register a callback that fires when the canvas resizes.
     * Receives the new width and height in physical pixels.
     */
    onResize(callback: (width: number, height: number) => void): void {
        this.resizeCallbacks.push(callback);
    }

    storePreviousState(): void {
        this.cameras.storePrevious();
        this.sprites.storePrevious();
    }

    render(alpha: number): void {
        if (!this._initialized) return;

        this.advanceTime();
        this.cameras.interpolate(alpha);

        // Sprite transforms and static data go once per frame.
        this.sprites.uploadData(this.core.device);

        const swapchainView = this.core.context.getCurrentTexture().createView();
        const views = this.cameras.ordered();

        let firstView = true;
        for (const camera of views) {
            // Pack and upload this view's visible slot list.
            this.sprites.prepareFrame(camera.mask);
            this.sprites.uploadSlots(this.core.device);

            // Upload uniforms (mat3x3 padded + alpha + resolution)
            const uniformData = this.core.uniformData;
            uniformData.set(camera.getMatrix(), 0);
            uniformData[12] = alpha;
            uniformData[14] = this._width;
            uniformData[15] = this._height;
            this.core.device.queue.writeBuffer(
                this.core.rawUniformBuffer, 0,
                uniformData.buffer, uniformData.byteOffset, 64,
            );

            const rect = camera.rect;
            const x = Math.max(0, Math.floor(rect.x * this._width));
            const y = Math.max(0, Math.floor(rect.y * this._height));
            const width = Math.max(1, Math.min(this._width - x, Math.floor(rect.width * this._width)));
            const height = Math.max(1, Math.min(this._height - y, Math.floor(rect.height * this._height)));
            const fullRect = x === 0 && y === 0 && width === this._width && height === this._height;

            const enabledEffects = camera.effects.enableCount();
            if (enabledEffects > 0 && !fullRect) {
                this.logger.warn('camera effects require a full-screen rect; effects are skipped for this view');
            }
            const effectsActive = enabledEffects > 0 && fullRect;
            const targetView = effectsActive
                ? this.cameraEffects.sceneTarget(this._width, this._height)
                : swapchainView;

            const clearColor = camera.clearColor === false
                ? undefined
                : (camera.clearColor ?? this._clearColor);
            // A clear affects the whole attachment. Only the first view clears by
            // default; later views load unless they opt in.
            const clear = firstView || (camera.clearColor !== undefined && camera.clearColor !== false);
            const loadOp = clear && clearColor !== undefined ? 'clear' : 'load';

            const encoder = this.core.device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: targetView,
                    loadOp,
                    storeOp: 'store',
                    ...(loadOp === 'clear' && clearColor !== undefined
                        ? { clearValue: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: clearColor[3] } }
                        : {}),
                }],
            });
            pass.setViewport?.(x, y, width, height, 0, 1);
            pass.setScissorRect?.(x, y, width, height);

            pass.setPipeline(this.core.rawPipeline);
            pass.setBindGroup(0, this.core.rawSpriteBindGroup);

            // Draw per batch using firstInstance to offset into the index buffer
            let drawOffset = 0;
            const batches = this.sprites.batches;
            const batchCount = this.sprites.batchCount;
            for (let i = 0; i < batchCount; i++) {
                const batch = batches[i]!;
                if (batch.count === 0) continue;
                const texBindGroup = this.sheets.bindGroup(batch.sheetId);
                if (!texBindGroup) continue;

                pass.setBindGroup(1, texBindGroup);
                pass.draw(6, batch.count, 0, drawOffset);
                drawOffset += batch.count;
            }

            pass.end();

            if (effectsActive) {
                this.cameraEffects.apply(
                    encoder,
                    swapchainView,
                    camera.effects,
                    this.elapsed,
                    this._width,
                    this._height,
                );
            }

            this.core.device.queue.submit([encoder.finish()]);
            firstView = false;
        }
    }

    /** Advance the render clock; the frame delta is clamped to avoid a large jump on resume. */
    private advanceTime(): void {
        const now = performance.now();
        if (this.lastRenderTime > 0) {
            this.elapsed += Math.min((now - this.lastRenderTime) / 1000, 0.1);
        }
        this.lastRenderTime = now;
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.resizeCallbacks.length = 0;
        this.cameraEffects?.destroy();
        this.core?.rawDynamicBuffer?.destroy();
        this.core?.rawStaticBuffer?.destroy();
        this.core?.rawUniformBuffer?.destroy();
        this.core?.rawSlotIndexBuffer?.destroy();
    }
}

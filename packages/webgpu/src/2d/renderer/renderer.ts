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
import { tgpu, d } from '../../shaders/typegpu';
import { BaseRenderer } from 'murow/renderer';
import type {
    AssetBucket,
    Renderer2DOptions,
    PrefabBucket2D,
    SpritesheetPrefab,
} from 'murow/renderer';
import { Logger } from 'murow/core';
import { DynamicSprite, StaticSprite, SpriteUniforms } from '../../core/types';
import { Renderer2DCore } from './core';
import {
    CameraManager2D,
    SpriteManager,
    SpritesheetManager,
    GeometryManager,
    ComputeManager,
    setPrefab2DHandle,
} from './managers';
import {
    createSpriteLayout,
    createTextureLayout,
    createSpriteVertex,
    createSpriteFragment,
    WebGPURaycast2D,
    RaycastController2D,
} from './internals';

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
}

export class WebGPU2DRenderer<A extends AssetBucket<'2d', any, any> = AssetBucket<'2d', any, any>> extends BaseRenderer<Renderer2DOptions> {
    /** Sprite instance budget. Fixed for the device lifetime. */
    readonly maxSprites: number;

    private readonly core: Renderer2DCore;
    private readonly logger: Logger;
    private readonly _prefabs: PrefabBucket2D | null;

    /** Pooled sprite facade. */
    sprites!: SpriteManager;
    /** Spritesheet upload facade. */
    sheets!: SpritesheetManager;
    /** Custom geometry facade. */
    geometry!: GeometryManager;
    /** GPU compute facade. */
    compute!: ComputeManager;
    /** 2D picking facade. */
    raycast!: WebGPURaycast2D;

    private resizeObserver: ResizeObserver | null = null;
    private readonly resizeCallbacks: ((width: number, height: number) => void)[] = [];

    constructor(canvas: HTMLCanvasElement, options: WebGPU2DRendererOptions<A>) {
        const resolvedMaxSprites = options.maxSprites ?? options.maxInstances ?? 1024;
        super(canvas, { ...options, maxSprites: resolvedMaxSprites });
        this.maxSprites = resolvedMaxSprites;
        this.core = new Renderer2DCore();
        this.logger = Logger.resolve(options.debug);
        this.core.camera = new CameraManager2D(canvas.width || 800, canvas.height || 600);
        this.core.width = canvas.width || 1;
        this.core.height = canvas.height || 1;
        this._prefabs = (options.assets?.prefabs as unknown as PrefabBucket2D | undefined) ?? null;
    }

    get device(): GPUDevice { return this.core.device; }
    get format(): GPUTextureFormat { return this.core.format; }

    /** The 2D camera. Shared with every manager through the renderer core. */
    get camera(): CameraManager2D { return this.core.camera; }

    /**
     * Project a 2D world point to canvas CSS pixels (for HTML overlays via
     * `murow/dom`). Writes `[x, y, depth]` into `out` (`z` is ignored in 2D).
     */
    worldToScreen(x: number, y: number, _z: number, out: Float32Array): boolean {
        const m = this.camera.getMatrix();
        const ndcX = m[0]! * x + m[4]! * y + m[8]!;
        const ndcY = m[1]! * x + m[5]! * y + m[9]!;
        const w = this.canvas.clientWidth || this._width;
        const h = this.canvas.clientHeight || this._height;
        out[0] = (ndcX * 0.5 + 0.5) * w;
        out[1] = (0.5 - ndcY * 0.5) * h;
        out[2] = 1 / Math.max(this.camera.zoom, 1e-4);
        return true;
    }

    async init(): Promise<void> {
        this.core.root = await tgpu.init();
        this.core.device = this.core.root.device;
        const device = this.core.device;

        this.core.context = this.canvas.getContext('webgpu')!;
        this.core.format = navigator.gpu.getPreferredCanvasFormat();
        this.core.context.configure({
            device,
            format: this.core.format,
            alphaMode: 'premultiplied',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.core.width = this._width;
        this.core.height = this._height;
        this.camera.setViewport(this._width, this._height);

        // TypeGPU layouts
        this.core.spriteLayout = createSpriteLayout(this.maxSprites);
        this.core.textureLayout = createTextureLayout();

        // TypeGPU shaders
        const vertex = createSpriteVertex(this.core.spriteLayout, this.core.textureLayout);
        const fragment = createSpriteFragment(this.core.spriteLayout, this.core.textureLayout);

        // TypeGPU render pipeline (no vertex buffer — quad generated from vertexIndex)
        const tgpuPipeline = this.core.root.createRenderPipeline({
            vertex,
            fragment,
            targets: {
                format: this.core.format,
                blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
            } as any,
            primitive: { topology: 'triangle-list' },
        });

        // Instance data buffers
        this.core.dynamicBuffer = this.core.root
            .createBuffer(d.arrayOf(DynamicSprite, this.maxSprites))
            .$usage('storage');
        this.core.staticBuffer = this.core.root
            .createBuffer(d.arrayOf(StaticSprite, this.maxSprites))
            .$usage('storage');
        this.core.uniformBuffer = this.core.root
            .createBuffer(SpriteUniforms)
            .$usage('uniform');
        this.core.slotIndexBuffer = this.core.root
            .createBuffer(d.arrayOf(d.u32, this.maxSprites))
            .$usage('storage');

        // Bind group for sprite data
        const spriteBindGroup = (this.core.root as any).createBindGroup(this.core.spriteLayout, {
            uniforms: this.core.uniformBuffer,
            dynamicInstances: this.core.dynamicBuffer,
            staticInstances: this.core.staticBuffer,
            slotIndices: this.core.slotIndexBuffer,
        });

        // Unwrap TypeGPU resources for raw render pass usage
        this.core.rawPipeline = this.core.root.unwrap(tgpuPipeline) as any;
        this.core.rawSpriteBindGroup = this.core.root.unwrap(spriteBindGroup) as any;
        this.core.rawTextureLayout = this.core.root.unwrap(this.core.textureLayout) as any;
        this.core.rawDynamicBuffer = this.core.root.unwrap(this.core.dynamicBuffer) as any;
        this.core.rawStaticBuffer = this.core.root.unwrap(this.core.staticBuffer) as any;
        this.core.rawSlotIndexBuffer = this.core.root.unwrap(this.core.slotIndexBuffer) as any;
        this.core.rawUniformBuffer = this.core.root.unwrap(this.core.uniformBuffer) as any;

        // Managers
        this.sheets = new SpritesheetManager(this.core);
        this.sprites = new SpriteManager({
            core: this.core,
            capacity: this.maxSprites,
            logger: this.logger,
            prefabs: this._prefabs,
        });
        this.geometry = new GeometryManager(this.core, this.canvas, () => this._clearColor);
        this.compute = new ComputeManager(this.core.root);

        if (this._prefabs) {
            this.uploadPrefabBucket(this._prefabs);
        }

        this.raycast = new WebGPURaycast2D(new RaycastController2D({
            camera: this.camera,
            eachSprite: this.sprites.eachSprite.bind(this.sprites),
            resolveHitbox: this.sprites.resolveHitbox.bind(this.sprites),
        }));

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

                this.camera.setViewport(w, h);

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
        this.camera.storePrevious();
        this.sprites.storePrevious();
    }

    render(alpha: number): void {
        if (!this._initialized) return;

        this.camera.interpolate(alpha);

        // Pack the frame's batches and upload the sprite buffers.
        this.sprites.prepareFrame();
        this.sprites.upload(this.core.device);

        // Upload uniforms (mat3x3 padded + alpha + resolution)
        const uniformData = this.core.uniformData;
        const matrix = this.camera.getMatrix();
        uniformData.set(matrix, 0);
        uniformData[12] = alpha;
        uniformData[14] = this._width;
        uniformData[15] = this._height;
        this.core.device.queue.writeBuffer(
            this.core.rawUniformBuffer, 0,
            uniformData.buffer, uniformData.byteOffset, 64,
        );

        // Render pass
        const textureView = this.core.context.getCurrentTexture().createView();
        const encoder = this.core.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: {
                    r: this._clearColor[0], g: this._clearColor[1],
                    b: this._clearColor[2], a: this._clearColor[3],
                },
            }],
        });

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
        this.core.device.queue.submit([encoder.finish()]);
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.resizeCallbacks.length = 0;
        this.core?.dynamicBuffer?.destroy();
        this.core?.staticBuffer?.destroy();
        this.core?.uniformBuffer?.destroy();
        this.core?.slotIndexBuffer?.destroy();
        this.core?.root?.destroy();
    }
}

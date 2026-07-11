/**
 * WebGPU2DRenderer — instanced 2D sprite renderer backed by TypeGPU.
 *
 * - One draw call per spritesheet batch (layer-sorted)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation between ticks
 * - TypeGPU for shaders, layouts, pipelines; raw device for hot-path uploads
 */
import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import { tgpu, d } from '../shaders/typegpu'; // used for buffer type creation
import { FreeList } from 'murow/core/free-list';
import { Base2DRenderer } from 'murow/renderer';
import type {
    Renderer2DOptions,
    SpriteHandle,
    SpriteOptions,
    SpritesheetHandle,
    SpritesheetSource,
} from 'murow/renderer';
import {
    DYNAMIC_FLOATS_PER_SPRITE,
    DYNAMIC_OFFSET_CURR_X,
    DYNAMIC_OFFSET_CURR_Y,
    DYNAMIC_OFFSET_CURR_ROTATION,
    DYNAMIC_OFFSET_PREV_X,
    DYNAMIC_OFFSET_PREV_Y,
    DYNAMIC_OFFSET_PREV_ROTATION,
    STATIC_FLOATS_PER_SPRITE,
    STATIC_OFFSET_SCALE_X,
    STATIC_OFFSET_SCALE_Y,
    STATIC_OFFSET_UV_MIN_X,
    STATIC_OFFSET_UV_MIN_Y,
    STATIC_OFFSET_UV_MAX_X,
    STATIC_OFFSET_UV_MAX_Y,
    STATIC_OFFSET_LAYER,
    STATIC_OFFSET_FLIP_X,
    STATIC_OFFSET_FLIP_Y,
    STATIC_OFFSET_OPACITY,
    STATIC_OFFSET_TINT_R,
    STATIC_OFFSET_TINT_G,
    STATIC_OFFSET_TINT_B,
    STATIC_OFFSET_TINT_A,
} from '../core/constants';
import { DynamicSprite, StaticSprite, SpriteUniforms } from '../core/types';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import { SpriteAccessor } from './sprite-accessor';
import { WebGPURaycast2D, type RaycastState2D } from './raycast';
import { Camera2D } from '../camera/camera-2d';
import {
    createSpriteLayout,
    createTextureLayout,
    createSpriteVertex,
    createSpriteFragment,
    type SpriteDataLayout,
    type SpriteTextureLayout,
} from './shader';
import {
    Spritesheet,
    createTextureFromBitmap,
} from '../spritesheet/spritesheet';
import { parseSpritesheet, type ParsedSpritesheet } from 'murow/renderer';
import { GeometryBuilder, type GeometryOptions } from '../geometry/geometry-builder';
import { ComputeBuilder, type ComputeOptions } from '../compute/compute-builder';
import type { PrefabBucket2D, Prefab2D, SpritesheetPrefab } from 'murow/renderer';
import { testHitbox2D, pointInQuad2D, type Hitbox } from 'murow/core/hitbox';

export interface WebGPU2DRendererOptions extends Renderer2DOptions {
    /**
     * Pre-loaded prefab bucket. When provided, the renderer uploads each prefab
     * to the GPU during `init()`, and `addSprite({ prefab: bucket.get('id') })`
     * resolves to the right spritesheet handle. The bucket must have `load()`
     * resolved before being passed in.
     */
    prefabs?: PrefabBucket2D;
    /**
     * How many sprite instances you intend to spawn. Used to size buffers when
     * `maxSprites` is not given explicitly. Defaults to 1024.
     */
    maxInstances?: number;
}

/** WeakMap of prefab → uploaded GPU handle, populated in init(). */
const prefab2DHandles = new WeakMap<Prefab2D, SpritesheetHandle>();

/** True iff value is a Prefab2D (returned from `bucket.get(...)`). */
function isPrefab2D(value: SpritesheetHandle | Prefab2D): value is Prefab2D {
    return (value as Prefab2D).type === 'spritesheet';
}

function resolveSpritePrefabHandle(prefab: Prefab2D): SpritesheetHandle {
    const h = prefab2DHandles.get(prefab);
    if (!h) {
        throw new Error(
            `Prefab '${prefab.id}' has no GPU handle — has the renderer's init() been called with this bucket?`,
        );
    }
    return h;
}

export class WebGPU2DRenderer extends Base2DRenderer {
    private root!: TgpuRoot;
    private _device!: GPUDevice;
    private context!: GPUCanvasContext;
    private _format!: GPUTextureFormat;

    get device(): GPUDevice { return this._device; }
    get format(): GPUTextureFormat { return this._format; }

    private spriteLayout!: SpriteDataLayout;
    private textureLayout!: SpriteTextureLayout;

    // CPU-side data (zero-GC flat arrays)
    private dynamicData: Float32Array;
    private staticData: Float32Array;
    private freeList: FreeList;
    private batcher: SparseBatcher;
    private staticDirty = false;

    // TypeGPU buffers
    private dynamicBuffer!: TgpuBuffer<any>;
    private staticBuffer!: TgpuBuffer<any>;
    private uniformBuffer!: TgpuBuffer<any>;
    private slotIndexBuffer!: TgpuBuffer<any>;

    // CPU-side slot index array (uploaded per frame with active indices)
    private slotIndexData!: Uint32Array;

    // Raw GPU resources (unwrapped from TypeGPU for batched rendering)
    private rawPipeline!: GPURenderPipeline;
    private rawSpriteBindGroup!: GPUBindGroup;
    private rawTextureLayout!: GPUBindGroupLayout;
    private rawDynamicBuffer!: GPUBuffer;
    private rawStaticBuffer!: GPUBuffer;
    private rawUniformBuffer!: GPUBuffer;
    private rawSlotIndexBuffer!: GPUBuffer;

    // Per-sheet bind groups
    private sheetBindGroups = new Map<number, GPUBindGroup>();
    private sheets = new Map<number, Spritesheet>();
    private nextSheetId = 0;

    readonly camera: Camera2D;
    readonly raycast: WebGPURaycast2D;
    private uniformData = new Float32Array(20);

    // Per-slot handle + optional hitbox, parallel to the sprite arrays.
    private spriteHandles: (SpriteAccessor | null)[];
    private spriteHitboxes: (Hitbox<'2d'> | null)[];
    private nextSpriteId = 0;

    private resizeObserver: ResizeObserver | null = null;
    private resizeCallbacks: ((width: number, height: number) => void)[] = [];

    private readonly _prefabs: PrefabBucket2D | null;

    constructor(canvas: HTMLCanvasElement, options: WebGPU2DRendererOptions) {
        const resolvedMaxSprites = options.maxSprites ?? options.maxInstances ?? 1024;
        super(canvas, { ...options, maxSprites: resolvedMaxSprites });
        this._prefabs = options.prefabs ?? null;
        this.camera = new Camera2D(canvas.width || 800, canvas.height || 600);
        this.raycast = new WebGPURaycast2D(this);
        this.freeList = new FreeList(resolvedMaxSprites);
        this.batcher = new SparseBatcher(resolvedMaxSprites);
        this.dynamicData = new Float32Array(resolvedMaxSprites * DYNAMIC_FLOATS_PER_SPRITE);
        this.staticData = new Float32Array(resolvedMaxSprites * STATIC_FLOATS_PER_SPRITE);
        this.slotIndexData = new Uint32Array(resolvedMaxSprites);
        this.spriteHandles = new Array(resolvedMaxSprites).fill(null);
        this.spriteHitboxes = new Array(resolvedMaxSprites).fill(null);
    }

    async init(): Promise<void> {
        this.root = await tgpu.init();
        this._device = this.root.device;

        this.context = this.canvas.getContext('webgpu')!;
        this._format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this._device,
            format: this._format,
            alphaMode: 'premultiplied',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.camera.setViewport(this._width, this._height);

        // TypeGPU layouts
        this.spriteLayout = createSpriteLayout(this.maxSprites);
        this.textureLayout = createTextureLayout();

        // TypeGPU shaders
        const vertex = createSpriteVertex(this.spriteLayout, this.textureLayout);
        const fragment = createSpriteFragment(this.spriteLayout, this.textureLayout);

        // TypeGPU render pipeline (no vertex buffer — quad generated from vertexIndex)
        const tgpuPipeline = this.root.createRenderPipeline({
            vertex,
            fragment,
            targets: {
                format: this._format,
                blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
            } as any,
            primitive: { topology: 'triangle-list' },
        });

        // Instance data buffers
        this.dynamicBuffer = this.root
            .createBuffer(d.arrayOf(DynamicSprite, this.maxSprites))
            .$usage('storage');
        this.staticBuffer = this.root
            .createBuffer(d.arrayOf(StaticSprite, this.maxSprites))
            .$usage('storage');
        this.uniformBuffer = this.root
            .createBuffer(SpriteUniforms)
            .$usage('uniform');
        this.slotIndexBuffer = this.root
            .createBuffer(d.arrayOf(d.u32, this.maxSprites))
            .$usage('storage');

        // Bind group for sprite data
        const spriteBindGroup = (this.root as any).createBindGroup(this.spriteLayout, {
            uniforms: this.uniformBuffer,
            dynamicInstances: this.dynamicBuffer,
            staticInstances: this.staticBuffer,
            slotIndices: this.slotIndexBuffer,
        });

        // Unwrap TypeGPU resources for raw render pass usage
        this.rawPipeline = this.root.unwrap(tgpuPipeline) as any;
        this.rawSpriteBindGroup = this.root.unwrap(spriteBindGroup) as any;
        this.rawTextureLayout = this.root.unwrap(this.textureLayout) as any;
        this.rawDynamicBuffer = this.root.unwrap(this.dynamicBuffer) as any;
        this.rawStaticBuffer = this.root.unwrap(this.staticBuffer) as any;
        this.rawSlotIndexBuffer = this.root.unwrap(this.slotIndexBuffer) as any;
        this.rawUniformBuffer = this.root.unwrap(this.uniformBuffer) as any;

        if (this._prefabs) {
            this.uploadPrefabBucket(this._prefabs);
        }

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
                const handle = this.uploadParsedSpritesheet((prefab as SpritesheetPrefab).parsed);
                prefab2DHandles.set(prefab, handle);
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

                if (this.options.autoResize) {
                    this.canvas.width = w;
                    this.canvas.height = h;
                    this.context.configure({
                        device: this._device,
                        format: this._format,
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

    async loadSpritesheet(source: SpritesheetSource): Promise<SpritesheetHandle> {
        const parsed = await parseSpritesheet(source);
        return this.uploadParsedSpritesheet(parsed);
    }

    /**
     * Upload a previously-parsed spritesheet to the GPU. Returns a SpritesheetHandle.
     * Splitting parse (CPU) from upload (GPU) lets callers parse spritesheets in parallel
     * before a renderer exists.
     */
    uploadParsedSpritesheet(parsed: ParsedSpritesheet): SpritesheetHandle {
        const { texture, view } = createTextureFromBitmap(this._device, parsed.bitmap);

        const sampler = this._device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        const id = this.nextSheetId++;
        const sheet = new Spritesheet(id, texture, view, sampler, parsed.uvs, parsed.width, parsed.height);
        this.sheets.set(id, sheet);

        const bindGroup = this._device.createBindGroup({
            layout: this.rawTextureLayout,
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: sampler },
            ],
        });
        this.sheetBindGroups.set(id, bindGroup);

        return sheet;
    }

    addSprite(opts: Omit<SpriteOptions, 'sheet'> & { sheet: SpritesheetHandle | Prefab2D }): SpriteHandle {
        const slot = this.freeList.allocate();
        if (slot === -1) throw new Error(`Max sprites (${this.maxSprites}) reached`);

        const dynBase = slot * DYNAMIC_FLOATS_PER_SPRITE;
        const statBase = slot * STATIC_FLOATS_PER_SPRITE;

        // Resolve prefab -> SpritesheetHandle if needed; a prefab may name a hitbox.
        const sheet = isPrefab2D(opts.sheet) ? resolveSpritePrefabHandle(opts.sheet) : opts.sheet;
        const hitboxName = isPrefab2D(opts.sheet) ? opts.sheet.hitbox : undefined;
        const lib = this._prefabs?.hitboxLibrary ?? null;
        const hitbox = hitboxName && lib ? (lib.get(hitboxName as never) as Hitbox<'2d'>) : null;

        const [px, py] = opts.position ?? [0, 0];
        this.dynamicData[dynBase + DYNAMIC_OFFSET_PREV_X] = px;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_PREV_Y] = py;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_CURR_X] = px;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_CURR_Y] = py;

        const rotation = opts.rotation ?? 0;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_PREV_ROTATION] = rotation;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_CURR_ROTATION] = rotation;

        const s = opts.scale;
        const [sx, sy] = typeof s === 'number' ? [s, s] : (s ?? [1, 1]);
        this.staticData[statBase + STATIC_OFFSET_SCALE_X] = sx;
        this.staticData[statBase + STATIC_OFFSET_SCALE_Y] = sy;

        const uv = sheet.getUV(opts.sprite ?? 0);
        this.staticData[statBase + STATIC_OFFSET_UV_MIN_X] = uv.minX;
        this.staticData[statBase + STATIC_OFFSET_UV_MIN_Y] = uv.minY;
        this.staticData[statBase + STATIC_OFFSET_UV_MAX_X] = uv.maxX;
        this.staticData[statBase + STATIC_OFFSET_UV_MAX_Y] = uv.maxY;

        this.staticData[statBase + STATIC_OFFSET_LAYER] = opts.layer ?? 0;
        this.staticData[statBase + STATIC_OFFSET_FLIP_X] = opts.flipX ? 1 : 0;
        this.staticData[statBase + STATIC_OFFSET_FLIP_Y] = opts.flipY ? 1 : 0;
        this.staticData[statBase + STATIC_OFFSET_OPACITY] = opts.opacity ?? 1;

        const tint = opts.tint ?? [1, 1, 1, 1];
        this.staticData[statBase + STATIC_OFFSET_TINT_R] = tint[0];
        this.staticData[statBase + STATIC_OFFSET_TINT_G] = tint[1];
        this.staticData[statBase + STATIC_OFFSET_TINT_B] = tint[2];
        this.staticData[statBase + STATIC_OFFSET_TINT_A] = tint[3];

        this.staticDirty = true;
        this.batcher.add(opts.layer ?? 0, sheet.id, slot);

        const accessor = new SpriteAccessor(
            this.dynamicData, this.staticData, this.nextSpriteId++, slot, sheet.id,
            () => { this.staticDirty = true; },
        );
        this.spriteHandles[slot] = accessor;
        this.spriteHitboxes[slot] = hitbox;
        return accessor;
    }

    removeSprite(sprite: SpriteHandle): void {
        const accessor = sprite as SpriteAccessor;
        this.batcher.remove(accessor.layer, accessor.sheetId, accessor.slot);
        this.freeList.free(accessor.slot);

        const dynBase = accessor.slot * DYNAMIC_FLOATS_PER_SPRITE;
        const statBase = accessor.slot * STATIC_FLOATS_PER_SPRITE;
        this.dynamicData.fill(0, dynBase, dynBase + DYNAMIC_FLOATS_PER_SPRITE);
        this.staticData.fill(0, statBase, statBase + STATIC_FLOATS_PER_SPRITE);
        this.spriteHandles[accessor.slot] = null;
        this.spriteHitboxes[accessor.slot] = undefined;
        this.staticDirty = true;
    }

    /**
     * Point-test every sprite against the unprojected cursor and push the
     * hits into the buffer. Sort key is `-layer` so the topmost sprite is
     * "nearest". A declared hitbox overrides the default rendered quad.
     */
    _collectRaycastHitsInto(screenX: number, screenY: number, rc: RaycastState2D): void {
        const [wx, wy] = this.camera.screenToWorld(screenX, screenY);
        const dyn = this.dynamicData;
        const stat = this.staticData;

        this.batcher.each((_sheetId, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.spriteHandles[slot];
                if (handle === null) continue;

                const dynBase = slot * DYNAMIC_FLOATS_PER_SPRITE;
                const statBase = slot * STATIC_FLOATS_PER_SPRITE;
                const cx = dyn[dynBase + DYNAMIC_OFFSET_CURR_X];
                const cy = dyn[dynBase + DYNAMIC_OFFSET_CURR_Y];
                const rot = dyn[dynBase + DYNAMIC_OFFSET_CURR_ROTATION];
                const sx = stat[statBase + STATIC_OFFSET_SCALE_X];
                const sy = stat[statBase + STATIC_OFFSET_SCALE_Y];
                const layer = stat[statBase + STATIC_OFFSET_LAYER];

                const hb = this.spriteHitboxes[slot];
                let part: string | null = null;
                if (hb) {
                    const hit = testHitbox2D(hb, cx, cy, sx, sy, rot, wx, wy);
                    if (!hit) continue;
                    part = hit.part;
                } else if (!pointInQuad2D(cx, cy, sx, sy, rot, wx, wy)) {
                    continue;
                }

                rc.push(handle, -layer, wx, wy, 0, layer, part);
            }
        });
    }

    storePreviousState(): void {
        this.camera.storePrevious();
        const dyn = this.dynamicData;
        this.batcher.each((_sheetId, instances, count) => {
            for (let i = 0; i < count; i++) {
                const base = instances[i] * DYNAMIC_FLOATS_PER_SPRITE;
                dyn[base + DYNAMIC_OFFSET_PREV_X] = dyn[base + DYNAMIC_OFFSET_CURR_X];
                dyn[base + DYNAMIC_OFFSET_PREV_Y] = dyn[base + DYNAMIC_OFFSET_CURR_Y];
                dyn[base + DYNAMIC_OFFSET_PREV_ROTATION] = dyn[base + DYNAMIC_OFFSET_CURR_ROTATION];
            }
        });
    }

    createGeometry(name: string, options: GeometryOptions): GeometryBuilder {
        return new GeometryBuilder(name, options, this.root, this._format, this.canvas, this._clearColor);
    }

    createCompute(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.root);
    }

    render(alpha: number): void {
        if (!this._initialized) return;

        this.camera.interpolate(alpha);

        // Upload dynamic data (every frame, zero-GC)
        this._device.queue.writeBuffer(
            this.rawDynamicBuffer, 0,
            this.dynamicData.buffer, this.dynamicData.byteOffset, this.dynamicData.byteLength,
        );

        // Upload static data (only when dirty)
        if (this.staticDirty) {
            this._device.queue.writeBuffer(
                this.rawStaticBuffer, 0,
                this.staticData.buffer, this.staticData.byteOffset, this.staticData.byteLength,
            );
            this.staticDirty = false;
        }

        // Upload uniforms (mat3x3 padded + alpha + resolution)
        const matrix = this.camera.getMatrix();
        this.uniformData.set(matrix, 0);
        this.uniformData[12] = alpha;
        this.uniformData[14] = this._width;
        this.uniformData[15] = this._height;
        this._device.queue.writeBuffer(
            this.rawUniformBuffer, 0,
            this.uniformData.buffer, this.uniformData.byteOffset, 64,
        );

        // Render pass
        const textureView = this.context.getCurrentTexture().createView();
        const encoder = this._device.createCommandEncoder();
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

        // Pack active slot indices into contiguous array (before encoding draw calls)
        let indexOffset = 0;
        this.batcher.each((_sheetId, instances, count) => {
            this.slotIndexData.set(instances.subarray(0, count), indexOffset);
            indexOffset += count;
        });

        // Upload slot index buffer
        if (indexOffset > 0) {
            this._device.queue.writeBuffer(
                this.rawSlotIndexBuffer, 0,
                this.slotIndexData.buffer, this.slotIndexData.byteOffset,
                indexOffset * 4,
            );
        }

        pass.setPipeline(this.rawPipeline);
        pass.setBindGroup(0, this.rawSpriteBindGroup);

        // Draw per batch using firstInstance to offset into the index buffer
        let drawOffset = 0;
        this.batcher.each((sheetId, _instances, count) => {
            const texBindGroup = this.sheetBindGroups.get(sheetId);
            if (!texBindGroup || count === 0) return;

            pass.setBindGroup(1, texBindGroup);
            pass.draw(6, count, 0, drawOffset);
            drawOffset += count;
        });

        pass.end();
        this._device.queue.submit([encoder.finish()]);
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.resizeCallbacks.length = 0;
        this.dynamicBuffer?.destroy();
        this.staticBuffer?.destroy();
        this.uniformBuffer?.destroy();
        this.slotIndexBuffer?.destroy();
        this.root?.destroy();
    }
}

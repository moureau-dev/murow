/**
 * WebGPU2DRenderer — instanced 2D sprite renderer backed by TypeGPU.
 *
 * - One draw call per spritesheet batch (layer-sorted)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation between ticks
 * - TypeGPU for shaders, layouts, pipelines; raw device for hot-path uploads
 */
import tgpu from 'typegpu';
import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import * as d from 'typegpu/data'; // used for buffer type creation
import { Base2DRenderer, FreeList } from 'murow';
import type {
    Renderer2DOptions,
    SpriteHandle,
    SpriteOptions,
    SpritesheetHandle,
    SpritesheetSource,
} from 'murow';
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
import { SparseBatcher } from 'murow';
import { SpriteAccessor } from './sprite-accessor';
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
    loadImage,
    createTextureFromBitmap,
    computeGridUVs,
    computeTexturePackerUVs,
    type TexturePackerData,
} from '../spritesheet/spritesheet';
import { GeometryBuilder, type GeometryOptions } from '../geometry/geometry-builder';
import { ComputeBuilder, type ComputeOptions } from '../compute/compute-builder';

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
    private uniformData = new Float32Array(20);

    private resizeObserver: ResizeObserver | null = null;
    private resizeCallbacks: ((width: number, height: number) => void)[] = [];

    constructor(canvas: HTMLCanvasElement, options: Renderer2DOptions) {
        super(canvas, options);
        this.camera = new Camera2D(canvas.width || 800, canvas.height || 600);
        this.freeList = new FreeList(options.maxSprites);
        this.batcher = new SparseBatcher(options.maxSprites);
        this.dynamicData = new Float32Array(options.maxSprites * DYNAMIC_FLOATS_PER_SPRITE);
        this.staticData = new Float32Array(options.maxSprites * STATIC_FLOATS_PER_SPRITE);
        this.slotIndexData = new Uint32Array(options.maxSprites);
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

        this.setupResizeObserver();
        this._initialized = true;
    }

    private setupResizeObserver(): void {
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const box = entry.devicePixelContentBoxSize?.[0] ?? entry.contentBoxSize[0];
                const w = box.inlineSize;
                const h = box.blockSize;
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
        this.resizeObserver.observe(this.canvas, { box: 'device-pixel-content-box' });
    }

    /**
     * Register a callback that fires when the canvas resizes.
     * Receives the new width and height in physical pixels.
     */
    onResize(callback: (width: number, height: number) => void): void {
        this.resizeCallbacks.push(callback);
    }

    async loadSpritesheet(source: SpritesheetSource): Promise<SpritesheetHandle> {
        const bitmap = await loadImage(source.image);
        const { texture, view } = createTextureFromBitmap(this._device, bitmap);

        const sampler = this._device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        let uvs;
        if (source.data) {
            const resp = await fetch(source.data);
            const json: TexturePackerData = await resp.json();
            uvs = computeTexturePackerUVs(json);
        } else if (source.frameWidth && source.frameHeight) {
            uvs = computeGridUVs(bitmap.width, bitmap.height, source.frameWidth, source.frameHeight);
        } else {
            uvs = [{ minX: 0, minY: 0, maxX: 1, maxY: 1 }];
        }

        const id = this.nextSheetId++;
        const sheet = new Spritesheet(id, texture, view, sampler, uvs, bitmap.width, bitmap.height);
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

    addSprite(opts: SpriteOptions): SpriteHandle {
        const slot = this.freeList.allocate();
        if (slot === -1) throw new Error(`Max sprites (${this.maxSprites}) reached`);

        const dynBase = slot * DYNAMIC_FLOATS_PER_SPRITE;
        const statBase = slot * STATIC_FLOATS_PER_SPRITE;

        const x = opts.x ?? 0;
        const y = opts.y ?? 0;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_PREV_X] = x;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_PREV_Y] = y;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_CURR_X] = x;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_CURR_Y] = y;

        const rotation = opts.rotation ?? 0;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_PREV_ROTATION] = rotation;
        this.dynamicData[dynBase + DYNAMIC_OFFSET_CURR_ROTATION] = rotation;

        this.staticData[statBase + STATIC_OFFSET_SCALE_X] = opts.scaleX ?? 1;
        this.staticData[statBase + STATIC_OFFSET_SCALE_Y] = opts.scaleY ?? 1;

        const uv = opts.sheet.getUV(opts.sprite ?? 0);
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
        this.batcher.add(opts.layer ?? 0, opts.sheet.id, slot);

        return new SpriteAccessor(
            this.dynamicData, this.staticData, slot, opts.sheet.id,
            () => { this.staticDirty = true; },
        );
    }

    removeSprite(sprite: SpriteHandle): void {
        const accessor = sprite as SpriteAccessor;
        this.batcher.remove(accessor.layer, accessor.sheetId, accessor.slot);
        this.freeList.free(accessor.slot);

        const dynBase = accessor.slot * DYNAMIC_FLOATS_PER_SPRITE;
        const statBase = accessor.slot * STATIC_FLOATS_PER_SPRITE;
        this.dynamicData.fill(0, dynBase, dynBase + DYNAMIC_FLOATS_PER_SPRITE);
        this.staticData.fill(0, statBase, statBase + STATIC_FLOATS_PER_SPRITE);
        this.staticDirty = true;
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

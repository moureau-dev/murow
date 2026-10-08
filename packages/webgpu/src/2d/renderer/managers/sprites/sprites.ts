import { PooledCollection } from 'murow/renderer/collection';
import type { Logger } from 'murow/core';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { Hitbox } from 'murow/core/hitbox';
import type {
    SpriteHandle,
    SpriteOptions,
    SpritesheetHandle,
    PrefabBucket2D,
    Prefab2D,
} from 'murow/renderer';
import type { Renderer2DCore } from '../../core';
import type { SpriteId } from '../../ids';
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
} from '../../../../core/constants';
import { SpriteAccessor } from './sprite-accessor';
import { isPrefab2D, resolveSpritePrefabHandle } from './prefab-handle';

/** A sprite creation request: a sheet handle or an uploaded prefab, plus sprite options. */
export type SpriteAddOptions = Omit<SpriteOptions, 'sheet'> & { sheet: SpritesheetHandle | Prefab2D };

/** A visible draw batch produced by `prepareFrame` (one spritesheet). */
export interface SpriteBatch {
    sheetId: number;
    offset: number;
    count: number;
}

/** What the sprite manager needs from the renderer. */
export interface SpriteManagerDeps {
    core: Renderer2DCore;
    capacity: number;
    logger: Logger;
    prefabs: PrefabBucket2D | null;
}

interface PendingSprite {
    opts: SpriteAddOptions;
    sheet: SpritesheetHandle;
    hitbox: Hitbox<'2d'> | null;
}

/**
 * SpriteManager owns the pooled sprite identity space, the CPU-side sprite data
 * arrays, the `SparseBatcher`, and per-slot hitboxes. It is a facade over the
 * renderer's shared `Renderer2DCore`.
 */
export class SpriteManager extends PooledCollection<SpriteId, SpriteAccessor, number> {
    private readonly core: Renderer2DCore;
    private readonly prefabs: PrefabBucket2D | null;
    private readonly dynamicData: Float32Array;
    private readonly staticData: Float32Array;
    private readonly batcher: SparseBatcher;
    private staticDirty = false;
    private pending: PendingSprite | null = null;
    private readonly accessors: (SpriteAccessor | null)[];
    private readonly hitboxes: (Hitbox<'2d'> | null)[];

    /** @internal CPU-side slot indices packed by `prepareFrame`. */
    readonly slotIndexData: Uint32Array;
    /** @internal Number of valid entries in `slotIndexData`. */
    slotIndexCount = 0;
    /** @internal Visible batches for the sprite pass; first `batchCount` entries. */
    readonly batches: SpriteBatch[] = [];
    /** @internal Number of valid entries in `batches`. */
    batchCount = 0;

    constructor(deps: SpriteManagerDeps) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger });
        this.core = deps.core;
        this.prefabs = deps.prefabs;
        this.dynamicData = new Float32Array(deps.capacity * DYNAMIC_FLOATS_PER_SPRITE);
        this.staticData = new Float32Array(deps.capacity * STATIC_FLOATS_PER_SPRITE);
        this.slotIndexData = new Uint32Array(deps.capacity);
        this.batcher = new SparseBatcher(deps.capacity);
        this.accessors = new Array(deps.capacity).fill(null);
        this.hitboxes = new Array(deps.capacity).fill(null);
    }

    /**
     * Add a sprite. A prefab source may name a hitbox, which is resolved from the
     * bucket's hitbox library.
     * @returns the sprite handle, or `null` when the pool is full.
     */
    add(opts: SpriteAddOptions): SpriteAccessor | null {
        const fromPrefab = isPrefab2D(opts.sheet);
        const sheet = fromPrefab ? resolveSpritePrefabHandle(opts.sheet as Prefab2D) : (opts.sheet as SpritesheetHandle);
        const hitboxName = fromPrefab ? (opts.sheet as Prefab2D).hitbox : undefined;
        const lib = this.prefabs?.hitboxLibrary ?? null;
        const hitbox = hitboxName && lib ? (lib.get(hitboxName as never) as Hitbox<'2d'>) : null;

        this.pending = { opts, sheet, hitbox };
        const allocated = this.allocateHandle();
        this.pending = null;
        return allocated ? allocated.handle : null;
    }

    /**
     * Snapshot curr -> prev for every live sprite.
     * @internal Called by the renderer's pre-tick, not for direct user calls.
     */
    storePrevious(): void {
        const dyn = this.dynamicData;
        const active = this.allocator.activeSlots;
        const size = this.allocator.size;
        for (let i = 0; i < size; i++) {
            const base = active[i]! * DYNAMIC_FLOATS_PER_SPRITE;
            dyn[base + DYNAMIC_OFFSET_PREV_X] = dyn[base + DYNAMIC_OFFSET_CURR_X];
            dyn[base + DYNAMIC_OFFSET_PREV_Y] = dyn[base + DYNAMIC_OFFSET_CURR_Y];
            dyn[base + DYNAMIC_OFFSET_PREV_ROTATION] = dyn[base + DYNAMIC_OFFSET_CURR_ROTATION];
        }
    }

    /**
     * Pack the visible slot indices contiguously and build the draw batch list.
     * @internal Called by the renderer each frame.
     */
    prepareFrame(): void {
        let indexOffset = 0;
        let batchCount = 0;
        this.batcher.each((sheetId, instances, count) => {
            if (count === 0) return;
            this.slotIndexData.set(instances.subarray(0, count), indexOffset);
            const batch = this.batchAt(batchCount++);
            batch.sheetId = sheetId;
            batch.offset = indexOffset;
            batch.count = count;
            indexOffset += count;
        });
        this.batchCount = batchCount;
        this.slotIndexCount = indexOffset;
    }

    /**
     * Upload the dynamic, static (when dirty) and slot-index buffers.
     * @internal Called by the renderer each frame.
     */
    upload(device: GPUDevice): void {
        const core = this.core;
        device.queue.writeBuffer(
            core.rawDynamicBuffer, 0,
            this.dynamicData.buffer, this.dynamicData.byteOffset, this.dynamicData.byteLength,
        );
        if (this.staticDirty) {
            device.queue.writeBuffer(
                core.rawStaticBuffer, 0,
                this.staticData.buffer, this.staticData.byteOffset, this.staticData.byteLength,
            );
            this.staticDirty = false;
        }
        if (this.slotIndexCount > 0) {
            device.queue.writeBuffer(
                core.rawSlotIndexBuffer, 0,
                this.slotIndexData.buffer, this.slotIndexData.byteOffset,
                this.slotIndexCount * 4,
            );
        }
    }

    /**
     * Visit every live sprite.
     * @internal Used by the 2D raycast controller.
     */
    eachSprite(visit: (handle: SpriteHandle) => void): void {
        const active = this.allocator.activeSlots;
        const size = this.allocator.size;
        for (let i = 0; i < size; i++) {
            const handle = this.accessors[active[i]!];
            if (handle) visit(handle);
        }
    }

    /**
     * The sprite's declared hitbox, or `null` to use its rendered quad.
     * @internal Used by the 2D raycast controller.
     */
    resolveHitbox(handle: SpriteHandle): Hitbox<'2d'> | null {
        return this.hitboxes[handle.slot] ?? null;
    }

    protected createHandle(id: SpriteId, slot: number): SpriteAccessor {
        const p = this.pending!;
        const opts = p.opts;
        const dynBase = slot * DYNAMIC_FLOATS_PER_SPRITE;
        const statBase = slot * STATIC_FLOATS_PER_SPRITE;

        const [px, py] = opts.position ?? [0, 0];
        const dyn = this.dynamicData;
        dyn[dynBase + DYNAMIC_OFFSET_PREV_X] = px;
        dyn[dynBase + DYNAMIC_OFFSET_PREV_Y] = py;
        dyn[dynBase + DYNAMIC_OFFSET_CURR_X] = px;
        dyn[dynBase + DYNAMIC_OFFSET_CURR_Y] = py;

        const rotation = opts.rotation ?? 0;
        dyn[dynBase + DYNAMIC_OFFSET_PREV_ROTATION] = rotation;
        dyn[dynBase + DYNAMIC_OFFSET_CURR_ROTATION] = rotation;

        const stat = this.staticData;
        const s = opts.scale;
        const [sx, sy] = typeof s === 'number' ? [s, s] : (s ?? [1, 1]);
        stat[statBase + STATIC_OFFSET_SCALE_X] = sx;
        stat[statBase + STATIC_OFFSET_SCALE_Y] = sy;

        const uv = p.sheet.getUV(opts.sprite ?? 0);
        stat[statBase + STATIC_OFFSET_UV_MIN_X] = uv.minX;
        stat[statBase + STATIC_OFFSET_UV_MIN_Y] = uv.minY;
        stat[statBase + STATIC_OFFSET_UV_MAX_X] = uv.maxX;
        stat[statBase + STATIC_OFFSET_UV_MAX_Y] = uv.maxY;

        stat[statBase + STATIC_OFFSET_LAYER] = opts.layer ?? 0;
        stat[statBase + STATIC_OFFSET_FLIP_X] = opts.flipX ? 1 : 0;
        stat[statBase + STATIC_OFFSET_FLIP_Y] = opts.flipY ? 1 : 0;
        stat[statBase + STATIC_OFFSET_OPACITY] = opts.opacity ?? 1;

        const tint = opts.tint ?? [1, 1, 1, 1];
        stat[statBase + STATIC_OFFSET_TINT_R] = tint[0];
        stat[statBase + STATIC_OFFSET_TINT_G] = tint[1];
        stat[statBase + STATIC_OFFSET_TINT_B] = tint[2];
        stat[statBase + STATIC_OFFSET_TINT_A] = tint[3];

        this.staticDirty = true;
        this.batcher.add(opts.layer ?? 0, p.sheet.id, slot);

        const accessor = new SpriteAccessor(
            this.dynamicData, this.staticData, id, slot, p.sheet.id,
            () => { this.staticDirty = true; },
        );
        Object.defineProperty(accessor, 'alive', { configurable: true, get: () => this.has(id) });
        accessor.destroy = () => this.remove(id);
        this.accessors[slot] = accessor;
        this.hitboxes[slot] = p.hitbox;
        return accessor;
    }

    protected destroySlot(slot: number): void {
        this.batcher.remove(0, 0, slot);
        const dynBase = slot * DYNAMIC_FLOATS_PER_SPRITE;
        const statBase = slot * STATIC_FLOATS_PER_SPRITE;
        this.dynamicData.fill(0, dynBase, dynBase + DYNAMIC_FLOATS_PER_SPRITE);
        this.staticData.fill(0, statBase, statBase + STATIC_FLOATS_PER_SPRITE);
        this.accessors[slot] = null;
        this.hitboxes[slot] = null;
        this.staticDirty = true;
    }

    private batchAt(index: number): SpriteBatch {
        let batch = this.batches[index];
        if (batch === undefined) {
            batch = { sheetId: 0, offset: 0, count: 0 };
            this.batches[index] = batch;
        }
        return batch;
    }
}

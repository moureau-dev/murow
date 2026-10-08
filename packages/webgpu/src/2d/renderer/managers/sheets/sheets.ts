import { GenerationAllocator } from 'murow/renderer/collection';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type {
    ParsedSpritesheet,
    SpritesheetHandle,
    SpritesheetSource,
} from 'murow/renderer';
import { parseSpritesheet } from 'murow/renderer';
import { Spritesheet, createTextureFromBitmap } from '../../../../spritesheet/spritesheet';
import type { Renderer2DCore } from '../../core';
import type { SheetId } from '../../ids';

/**
 * SpritesheetManager uploads parsed spritesheets and owns their GPU bind groups.
 * Sheet ids are versioned; the batcher's sheet field and the bind-group table
 * are indexed by the decoded slot.
 */
export class SpritesheetManager {
    private readonly allocator = new GenerationAllocator(SparseBatcher.MAX_SHEETS);
    private readonly sheets: (Spritesheet | null)[] = new Array(SparseBatcher.MAX_SHEETS).fill(null);
    private readonly bindGroups: (GPUBindGroup | null)[] = new Array(SparseBatcher.MAX_SHEETS).fill(null);

    constructor(private readonly core: Renderer2DCore) {}

    /** Parse a spritesheet source and upload it to the GPU. */
    async load(source: SpritesheetSource): Promise<SpritesheetHandle> {
        const parsed = await parseSpritesheet(source);
        return this.upload(parsed);
    }

    /**
     * Upload a previously-parsed spritesheet to the GPU.
     * @throws when the sheet ceiling (`SparseBatcher.MAX_SHEETS`) is reached.
     */
    upload(parsed: ParsedSpritesheet): Spritesheet {
        const packed = this.allocator.allocate();
        if (packed === -1) {
            throw new Error(`Max spritesheets (${SparseBatcher.MAX_SHEETS}) reached`);
        }
        const slot = this.allocator.slotOf(packed);
        const id = packed as SheetId;
        const device = this.core.device;

        const { texture, view } = createTextureFromBitmap(device, parsed.bitmap);
        const sampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });
        const sheet = new Spritesheet(id, texture, view, sampler, parsed.uvs, parsed.width, parsed.height);

        const bindGroup = device.createBindGroup({
            layout: this.core.rawTextureLayout,
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: sampler },
            ],
        });
        this.sheets[slot] = sheet;
        this.bindGroups[slot] = bindGroup;
        return sheet;
    }

    /** The sheet for `id`, or `undefined` when absent or stale. */
    get(id: SheetId): Spritesheet | undefined {
        if (!this.allocator.isLive(id)) return undefined;
        return this.sheets[this.allocator.slotOf(id)] ?? undefined;
    }

    /**
     * The texture bind group for a sheet id, or `null`.
     * @internal Used by the sprite pass.
     */
    bindGroup(id: number): GPUBindGroup | null {
        if (!this.allocator.isLive(id)) return null;
        return this.bindGroups[this.allocator.slotOf(id)] ?? null;
    }
}

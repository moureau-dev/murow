import { SlotSet } from 'murow/core/slot-map';
import { DYNAMIC_MESH_FLOATS } from '../engine-core/types';
import { DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ, MAX_LOD_LEVELS } from './offsets';

/**
 * Per-instance level-of-detail state and selection for the non-skinned instance
 * store. Owns one row of `MAX_LOD_LEVELS` per slot (model id, radius, distance)
 * plus the dense `slots` membership, and runs the near-to-far distance test.
 *
 * The owning store supplies the packed `dynamicData` positions and an `apply`
 * callback that moves an instance to its selected model (the batcher swap lives
 * in the store, not here).
 */
export class InstanceLodStore {
    /** Dense membership of slots with more than one level. */
    readonly slots: SlotSet;
    /** Per-slot level count (0 = no LOD). */
    private readonly count: Uint8Array;
    /** Per-slot, per-level model id. */
    private readonly modelIds: Uint8Array;
    /** Per-slot, per-level max distance squared (last level = Infinity). */
    private readonly distSq: Float32Array;
    /** Per-slot currently selected level. */
    private readonly current: Uint8Array;

    constructor(capacity: number) {
        this.slots = new SlotSet(capacity);
        this.count = new Uint8Array(capacity);
        this.modelIds = new Uint8Array(capacity * MAX_LOD_LEVELS);
        this.distSq = new Float32Array(capacity * MAX_LOD_LEVELS);
        this.current = new Uint8Array(capacity);
    }

    /**
     * Attach a level chain to a slot (near -> far; level 0 is the spawned model;
     * the last level's distance should be Infinity). No-op below two levels.
     */
    setLevels(opts: {
        slot: number;
        modelIds: readonly number[];
        distSq: readonly number[];
    }): void {
        const { slot, modelIds, distSq } = opts;
        const n = Math.min(modelIds.length, MAX_LOD_LEVELS);
        if (n < 2) return;
        const base = slot * MAX_LOD_LEVELS;
        for (let i = 0; i < n; i++) {
            this.modelIds[base + i] = modelIds[i]!;
            this.distSq[base + i] = distSq[i]!;
        }
        this.count[slot] = n;
        this.current[slot] = 0;
        this.slots.add(slot);
    }

    /** Forget a slot's levels (called on destroy). */
    clear(slot: number): void {
        this.slots.remove(slot);
        this.count[slot] = 0;
        this.current[slot] = 0;
    }

    /** The slot's current level (0 when it has no LOD chain). */
    levelOf(slot: number): number {
        return this.current[slot] ?? 0;
    }

    /**
     * Pick a level per slot from the camera position, calling `apply(slot, modelId)`
     * on change. `bias` scales every distance (`>1` keeps detail farther out);
     * `hysteresis` is the fractional band that must be crossed before a change.
     * @returns the number of level changes.
     */
    select(
        dynamicData: Float32Array,
        camX: number,
        camY: number,
        camZ: number,
        bias: number,
        hysteresis: number,
        apply: (slot: number, modelId: number) => void,
    ): number {
        const bias2 = bias * bias;
        const active = this.slots.denseBuffer;
        const n = this.slots.size;
        let swaps = 0;
        for (let i = 0; i < n; i++) {
            const slot = active[i]!;
            const count = this.count[slot]!;
            if (count < 2) continue;

            const dynBase = slot * DYNAMIC_MESH_FLOATS;
            const dx = dynamicData[dynBase + DYN_CURR_PX]! - camX;
            const dy = dynamicData[dynBase + DYN_CURR_PY]! - camY;
            const dz = dynamicData[dynBase + DYN_CURR_PZ]! - camZ;
            const d2 = dx * dx + dy * dy + dz * dz;

            const row = slot * MAX_LOD_LEVELS;
            let target = 0;
            while (target < count - 1 && d2 > this.distSq[row + target]! * bias2) target++;

            const cur = this.current[slot]!;
            if (target === cur) continue;
            if (target > cur) {
                // Only coarsen once clearly past the current level's boundary.
                if (d2 <= this.distSq[row + cur]! * bias2 * (1 + hysteresis)) continue;
            } else {
                // Only refine once clearly inside the target level's boundary.
                if (d2 >= this.distSq[row + target]! * bias2 * (1 - hysteresis)) continue;
            }
            apply(slot, this.modelIds[row + target]!);
            this.current[slot] = target;
            swaps++;
        }
        return swaps;
    }
}

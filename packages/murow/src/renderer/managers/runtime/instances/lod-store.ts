import { SlotSet } from 'murow/core/slot-map';
import { DYNAMIC_MESH_FLOATS } from '../engine-core/types';
import { DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ, DYN_MORPH, MAX_LOD_LEVELS } from './offsets';

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
    /** Per-slot fade target while morphing, or -1 when settled. */
    private readonly fadeTo: Int8Array;
    /** Per-slot fade progress in [0, 1]. */
    private readonly fadeT: Float32Array;
    /**
     * Geomorph fade length in ticks. `0` (default) hard-switches; the renderer
     * raises it to blend adjacent levels on the GPU.
     */
    fadeTicks = 0;

    constructor(capacity: number) {
        this.slots = new SlotSet(capacity);
        this.count = new Uint8Array(capacity);
        this.modelIds = new Uint8Array(capacity * MAX_LOD_LEVELS);
        this.distSq = new Float32Array(capacity * MAX_LOD_LEVELS);
        this.current = new Uint8Array(capacity);
        this.fadeTo = new Int8Array(capacity).fill(-1);
        this.fadeT = new Float32Array(capacity);
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
        this.fadeTo[slot] = -1;
        this.fadeT[slot] = 0;
        this.slots.add(slot);
    }

    /** Forget a slot's levels (called on destroy). */
    clear(slot: number): void {
        this.slots.remove(slot);
        this.count[slot] = 0;
        this.current[slot] = 0;
        this.fadeTo[slot] = -1;
        this.fadeT[slot] = 0;
    }

    /** The slot's current level (0 when it has no LOD chain). */
    levelOf(slot: number): number {
        return this.current[slot] ?? 0;
    }

    /**
     * Advance in-progress geomorphs by one tick, writing each slot's `morph`
     * (0 = lower level, 1 = upper) into the dynamic instance data. No-op unless
     * `fadeTicks > 0`.
     */
    advanceFades(dynamicData: Float32Array, apply: (slot: number, modelId: number) => void): void {
        if (this.fadeTicks <= 0) return;
        const step = 1 / this.fadeTicks;
        const active = this.slots.denseBuffer;
        const n = this.slots.size;
        for (let i = 0; i < n; i++) {
            const slot = active[i]!;
            const to = this.fadeTo[slot]!;
            if (to === -1) continue;
            const row = slot * MAX_LOD_LEVELS;
            let t = this.fadeT[slot]! + step;
            if (t >= 1) {
                this.current[slot] = to;
                this.fadeTo[slot] = -1;
                this.fadeT[slot] = 0;
                apply(slot, this.modelIds[row + to]!);
                dynamicData[slot * DYNAMIC_MESH_FLOATS + DYN_MORPH] = 0;
            } else {
                this.fadeT[slot] = t;
                dynamicData[slot * DYNAMIC_MESH_FLOATS + DYN_MORPH] = to > this.current[slot]! ? t : 1 - t;
            }
        }
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
            if (this.fadeTo[slot] !== -1) continue; // busy morphing

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
            if (this.fadeTicks > 0 && (target === cur + 1 || target === cur - 1)) {
                // Begin a geomorph at the lower level (the batch's model); the
                // shader blends `position` (lo) to `positionB` (hi) by `morph`.
                const lo = cur < target ? cur : target;
                this.fadeTo[slot] = target;
                this.fadeT[slot] = 0;
                apply(slot, this.modelIds[row + lo]!);
                dynamicData[slot * DYNAMIC_MESH_FLOATS + DYN_MORPH] = target > cur ? 0 : 1;
            } else {
                apply(slot, this.modelIds[row + target]!);
                this.current[slot] = target;
            }
            swaps++;
        }
        return swaps;
    }
}

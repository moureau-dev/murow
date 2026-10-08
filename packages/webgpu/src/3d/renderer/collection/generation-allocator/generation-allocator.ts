import { SlotMap } from 'murow/core/slot-map';

/**
 * Allocates dense slots and hands out generation-versioned ids.
 *
 * The id packs a generation and a slot with arithmetic, `generation * capacity
 * + slot`, so decoding is exact in float64 and there is no 32-bit bitwise sign
 * hazard. Reusing a slot bumps its generation, so a stored id for a destroyed
 * item stops matching and fails lookup instead of aliasing the new occupant.
 */
export class GenerationAllocator {
    private readonly slots: SlotMap;
    private readonly generations: Uint32Array;
    private readonly capacityValue: number;

    constructor(capacity: number) {
        this.capacityValue = capacity;
        this.slots = new SlotMap(capacity);
        this.generations = new Uint32Array(capacity);
    }

    /** Configured slot capacity. */
    get capacity(): number {
        return this.capacityValue;
    }

    /** Number of live slots. */
    get size(): number {
        return this.slots.size;
    }

    /** Packed live slots over `[0, size)`. Reused across calls. */
    get activeSlots(): Uint32Array {
        return this.slots.activeSlots;
    }

    /** Whether another slot can be allocated. */
    hasAvailable(): boolean {
        return this.slots.hasAvailable();
    }

    /**
     * Allocate a slot and return its versioned id.
     * @returns the id, or `-1` when the pool is exhausted.
     */
    alloc(): number {
        const slot = this.slots.add();
        if (slot === -1) return -1;
        return this.pack(this.generations[slot]!, slot);
    }

    /** Release the slot behind `id` and bump its generation. No-op if stale. */
    free(id: number): void {
        if (!this.isLive(id)) return;
        const slot = this.slotOf(id);
        this.generations[slot] = this.generations[slot]! + 1;
        this.slots.remove(slot);
    }

    /** Whether `id` is currently live. O(1). */
    isLive(id: number): boolean {
        if (this.capacityValue <= 0) return false;
        const slot = id % this.capacityValue;
        return this.slots.has(slot) && this.generations[slot] === this.genOf(id);
    }

    /** The dense slot for `id`. O(1). */
    slotOf(id: number): number {
        return this.capacityValue <= 0 ? -1 : id % this.capacityValue;
    }

    /** Empty the allocator. Outstanding ids become stale. */
    clear(): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            this.generations[slot] = this.generations[slot]! + 1;
        }
        this.slots.clear();
    }

    private genOf(id: number): number {
        return Math.floor(id / this.capacityValue);
    }

    private pack(generation: number, slot: number): number {
        return generation * this.capacityValue + slot;
    }
}

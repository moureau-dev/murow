/**
 * Free list allocator. Zero-GC, O(1) alloc/free.
 */
export class FreeList {
    private freeList: Uint32Array;
    private freeCount: number;
    private capacity: number;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.freeList = new Uint32Array(capacity);

        // Initialize: all indices are available
        for (let i = 0; i < capacity; i++) {
            this.freeList[i] = i;
        }
        this.freeCount = capacity;
    }

    /**
     * Allocate an index from the pool.
     * @returns Available index, or -1 if exhausted
     */
    allocate(): number {
        if (this.freeCount === 0) return -1;

        return this.freeList[--this.freeCount];
    }

    /**
     * Return an index to the pool for reuse.
     * @param index Index to free
     */
    free(index: number): void {
        if (this.freeCount >= this.capacity) {
            throw new Error("Double free detected!");
        }

        this.freeList[this.freeCount++] = index;
    }

    /**
     * Check if an index can be allocated.
     */
    hasAvailable(): boolean {
        return this.freeCount > 0;
    }

    /**
     * Get number of available slots.
     */
    getAvailableCount(): number {
        return this.freeCount;
    }

    /**
     * Get number of allocated slots.
     */
    getAllocatedCount(): number {
        return this.capacity - this.freeCount;
    }
}

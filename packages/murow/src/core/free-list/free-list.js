/**
 * Free list allocator. Zero-GC, O(1) alloc/free.
 */
export class FreeList {
    constructor(capacity) {
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
    allocate() {
        if (this.freeCount === 0)
            return -1;
        return this.freeList[--this.freeCount];
    }
    /**
     * Return an index to the pool for reuse.
     * @param index Index to free
     */
    free(index) {
        if (this.freeCount >= this.capacity) {
            throw new Error("Double free detected!");
        }
        this.freeList[this.freeCount++] = index;
    }
    /**
     * Check if an index can be allocated.
     */
    hasAvailable() {
        return this.freeCount > 0;
    }
    /**
     * Get number of available slots.
     */
    getAvailableCount() {
        return this.freeCount;
    }
    /**
     * Get number of allocated slots.
     */
    getAllocatedCount() {
        return this.capacity - this.freeCount;
    }
}

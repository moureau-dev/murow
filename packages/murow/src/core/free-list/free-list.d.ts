/**
 * Free list allocator. Zero-GC, O(1) alloc/free.
 */
export declare class FreeList {
    private freeList;
    private freeCount;
    private capacity;
    constructor(capacity: number);
    /**
     * Allocate an index from the pool.
     * @returns Available index, or -1 if exhausted
     */
    allocate(): number;
    /**
     * Return an index to the pool for reuse.
     * @param index Index to free
     */
    free(index: number): void;
    /**
     * Check if an index can be allocated.
     */
    hasAvailable(): boolean;
    /**
     * Get number of available slots.
     */
    getAvailableCount(): number;
    /**
     * Get number of allocated slots.
     */
    getAllocatedCount(): number;
}

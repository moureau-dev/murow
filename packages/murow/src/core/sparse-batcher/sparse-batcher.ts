/**
 * SparseBatcher — organizes sprite slots into [layer][sheet] buckets for draw calls.
 * Only allocates buckets that are actually used. Most games use <10 buckets total.
 *
 * Memory (10k sprites, 3 layers × 4 sheets = 12 buckets):
 *   buckets:       12 × 10,000 × 4 bytes = ~480 KB (lazy, only used buckets)
 *   bucketSizes:   16384 × 4 bytes       = 64 KB
 *   activeBuckets: 16384 × 2 bytes       = 32 KB
 *   Total: ~576 KB base + buckets as needed
 *
 * MAX_SHEETS = 64 supports up to 64 unique model/spritesheet IDs per layer.
 */
export class SparseBatcher {
    private static readonly MAX_LAYERS = 256;
    /** Number of sheet slots per layer. Sheet ids must be below this. */
    static readonly MAX_SHEETS = 64;
    private static readonly MAX_BUCKETS = SparseBatcher.MAX_LAYERS * SparseBatcher.MAX_SHEETS;
    private readonly BUCKET_INITIAL_SIZE = 256;

    private buckets = new Map<number, Uint32Array>();
    private bucketSizes = new Uint32Array(SparseBatcher.MAX_BUCKETS);
    private activeBuckets = new Uint16Array(SparseBatcher.MAX_BUCKETS);
    private sortBuffer = new Uint16Array(SparseBatcher.MAX_BUCKETS);
    private activeCount = 0;
    private readonly capacity: number;

    /** slot -> flat bucket key, or -1 when not batched. */
    private readonly slotBucket: Int32Array;
    /** slot -> index within its bucket, or -1 when not batched. */
    private readonly slotIndex: Int32Array;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.slotBucket = new Int32Array(capacity).fill(-1);
        this.slotIndex = new Int32Array(capacity).fill(-1);
    }

    /**
     * Compute a flat key from layer + sheet.
     */
    private key(layer: number, sheetId: number): number {
        return layer * SparseBatcher.MAX_SHEETS + sheetId;
    }

    /**
     * Register a sprite slot into its (layer, sheet) bucket.
     */
    add(layer: number, sheetId: number, slot: number): void {
        const key = this.key(layer, sheetId);

        if (!this.buckets.has(key)) {
            this.buckets.set(key, new Uint32Array(this.BUCKET_INITIAL_SIZE));
        }

        if (this.bucketSizes[key] === 0) {
            this.activeBuckets[this.activeCount++] = key;
        }

        let bucket = this.buckets.get(key)!;
        const size = this.bucketSizes[key];

        // grow if needed. rare, only on first filling
        if (size >= bucket.length) {
            const grown = new Uint32Array(bucket.length * 2);
            grown.set(bucket);
            this.buckets.set(key, grown);
            bucket = grown;
        }

        bucket[size] = slot;
        this.bucketSizes[key] = size + 1;
        this.slotBucket[slot] = key;
        this.slotIndex[slot] = size;
    }

    /**
     * Remove a sprite slot from its (layer, sheet) bucket.
     */
    remove(layer: number, sheetId: number, slot: number): void {
        if (slot < 0 || slot >= this.capacity) return;
        const key = this.slotBucket[slot];
        if (key === -1) return;
        const size = this.bucketSizes[key];
        if (size === 0) {
            this.slotBucket[slot] = -1;
            this.slotIndex[slot] = -1;
            return;
        }

        const bucket = this.buckets.get(key)!;
        const idx = this.slotIndex[slot];
        const last = bucket[size - 1]!;

        bucket[idx] = last;
        this.slotIndex[last] = idx;
        this.slotBucket[last] = key;
        this.bucketSizes[key] = size - 1;

        this.slotBucket[slot] = -1;
        this.slotIndex[slot] = -1;

        if (size - 1 === 0) {
            for (let i = 0; i < this.activeCount; i++) {
                if (this.activeBuckets[i] === key) {
                    this.activeBuckets[i] = this.activeBuckets[--this.activeCount];
                    break;
                }
            }
        }
    }

    /**
     * Iterate active buckets in layer order (back-to-front), zero allocations.
     * Callback receives sheetId and a subarray view of instance indices.
     */
    each(cb: (sheetId: number, instances: Uint32Array, count: number) => void): void {
        this.sortBuffer.set(this.activeBuckets.subarray(0, this.activeCount));

        // insertion sort. activeCount is tiny in practice
        for (let i = 1; i < this.activeCount; i++) {
            const key = this.sortBuffer[i];
            let j = i - 1;
            while (j >= 0 && this.sortBuffer[j] > key) {
                this.sortBuffer[j + 1] = this.sortBuffer[j--];
            }
            this.sortBuffer[j + 1] = key;
        }

        for (let i = 0; i < this.activeCount; i++) {
            const key = this.sortBuffer[i];
            const sheetId = key % SparseBatcher.MAX_SHEETS;
            const count = this.bucketSizes[key];
            cb(sheetId, this.buckets.get(key)!.subarray(0, count), count);
        }
    }

    /**
     * Get the number of active buckets.
     */
    getActiveCount(): number {
        return this.activeCount;
    }

    /**
     * Get total sprite count across all buckets.
     */
    getTotalCount(): number {
        let total = 0;
        for (let i = 0; i < this.activeCount; i++) {
            total += this.bucketSizes[this.activeBuckets[i]];
        }
        return total;
    }

    /**
     * Clear all buckets.
     */
    clear(): void {
        this.buckets.clear();
        this.bucketSizes.fill(0);
        this.activeCount = 0;
        this.slotBucket.fill(-1);
        this.slotIndex.fill(-1);
    }
}

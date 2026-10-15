import { GridCore } from '../grid-core';

export interface SpatialHashOptions {
    /** Cell edge length in world units. */
    cellSize: number;
    /** Maximum id + 1. Ids must be in `[0, capacity)`. */
    capacity: number;
    /** Bucket-table size; rounded up to a power of two. Default 1024. */
    buckets?: number;
}

// Teschner et al. 2003 spatial-hash mixing primes:
//   key = (cellX * HASH_X) ^ (cellY * HASH_Y)
const HASH_X = 73856093;
const HASH_Y = 19349663;

/**
 * Unbounded hashed grid. Cells are hashed into a fixed bucket table, so no
 * region is needed and coordinates may be negative or large. Hash collisions
 * merge buckets, so `query` may return extra ids; re-test at the call site.
 */
export class SpatialHash extends GridCore {
    private readonly mask: number;

    constructor(options: SpatialHashOptions) {
        let buckets = 1;
        const want = Math.max(1, options.buckets ?? 1024);
        while (buckets < want) buckets <<= 1;
        super(options.capacity, buckets, options.cellSize);
        this.mask = buckets - 1;
    }

    protected slotOfCell(cx: number, cy: number): number {
        return (Math.imul(cx, HASH_X) ^ Math.imul(cy, HASH_Y)) & this.mask;
    }
}

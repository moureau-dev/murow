import type { AABB } from '../types';
import type { SpatialIndex } from '../spatial-index';
import { TreeCore } from '../tree-core';

export interface QuadtreeOptions {
    /** Root region. Boxes outside are still inserted but always tested at the root. */
    bounds: AABB;
    /** Maximum id + 1. Ids must be in `[0, capacity)`. */
    capacity: number;
    /** Entries per node before it subdivides. Default 8. */
    maxItems?: number;
    /** Maximum subdivision depth. Default 8. */
    maxDepth?: number;
    /** Node pool size. Defaults to `capacity * 2`. */
    maxNodes?: number;
}

/**
 * Dynamic quadtree. A node subdivides into 4 quadrants past `maxItems` (down to
 * `maxDepth`); an entry that fits entirely in one quadrant descends, otherwise it
 * stays at the node.
 */
export class Quadtree extends TreeCore implements SpatialIndex {
    private readonly sxMin = new Float32Array(2);
    private readonly sxMax = new Float32Array(2);

    constructor(options: QuadtreeOptions) {
        const b = options.bounds;
        super({
            capacity: options.capacity,
            dim: 2,
            branching: 4,
            maxItems: options.maxItems ?? 8,
            maxDepth: options.maxDepth ?? 8,
            rootMin: [b.minX, b.minY],
            rootMax: [b.maxX, b.maxY],
            maxNodes: options.maxNodes,
        });
    }

    insert(id: number, bounds: AABB): void {
        this.sxMin[0] = bounds.minX;
        this.sxMin[1] = bounds.minY;
        this.sxMax[0] = bounds.maxX;
        this.sxMax[1] = bounds.maxY;
        this.insertFlat(id, this.sxMin, this.sxMax);
    }

    update(id: number, bounds: AABB): void {
        this.insert(id, bounds);
    }

    query(bounds: AABB, results: number[]): void {
        this.sxMin[0] = bounds.minX;
        this.sxMin[1] = bounds.minY;
        this.sxMax[0] = bounds.maxX;
        this.sxMax[1] = bounds.maxY;
        this.queryFlat(this.sxMin, this.sxMax, results);
    }
}

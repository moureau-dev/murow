import type { AABB3 } from '../types';
import type { SpatialIndex3D } from '../spatial-index';
import { TreeCore } from '../tree-core';

export interface OctreeOptions {
    /** Root region. Boxes outside are still inserted but always tested at the root. */
    bounds: AABB3;
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
 * Dynamic octree. A node subdivides into 8 octants past `maxItems` (down to
 * `maxDepth`); an entry that fits entirely in one octant descends, otherwise it
 * stays at the node.
 */
export class Octree extends TreeCore implements SpatialIndex3D {
    private readonly sxMin = new Float32Array(3);
    private readonly sxMax = new Float32Array(3);

    constructor(options: OctreeOptions) {
        const b = options.bounds;
        super({
            capacity: options.capacity,
            dim: 3,
            branching: 8,
            maxItems: options.maxItems ?? 8,
            maxDepth: options.maxDepth ?? 8,
            rootMin: [b.minX, b.minY, b.minZ],
            rootMax: [b.maxX, b.maxY, b.maxZ],
            maxNodes: options.maxNodes,
        });
    }

    insert(id: number, bounds: AABB3): void {
        this.sxMin[0] = bounds.minX;
        this.sxMin[1] = bounds.minY;
        this.sxMin[2] = bounds.minZ;
        this.sxMax[0] = bounds.maxX;
        this.sxMax[1] = bounds.maxY;
        this.sxMax[2] = bounds.maxZ;
        this.insertFlat(id, this.sxMin, this.sxMax);
    }

    update(id: number, bounds: AABB3): void {
        this.insert(id, bounds);
    }

    query(bounds: AABB3, results: number[]): void {
        this.sxMin[0] = bounds.minX;
        this.sxMin[1] = bounds.minY;
        this.sxMin[2] = bounds.minZ;
        this.sxMax[0] = bounds.maxX;
        this.sxMax[1] = bounds.maxY;
        this.sxMax[2] = bounds.maxZ;
        this.queryFlat(this.sxMin, this.sxMax, results);
    }
}

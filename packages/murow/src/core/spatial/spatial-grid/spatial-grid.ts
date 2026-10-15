import type { AABB } from '../types';
import { GridCore } from '../grid-core';

export interface SpatialGridOptions {
    /** Fixed region the grid covers. Boxes outside clamp to the edge cells. */
    bounds: AABB;
    /** Cell edge length in world units. */
    cellSize: number;
    /** Maximum id + 1. Ids must be in `[0, capacity)`. */
    capacity: number;
}

/**
 * Bounded uniform grid. Cells are fixed from `bounds` and `cellSize`; exact, no
 * hashing. A box is filed into every cell it overlaps, so `query` may return ids
 * whose exact box does not overlap the query box — re-test at the call site.
 */
export class SpatialGrid extends GridCore {
    private readonly cols: number;
    private readonly rows: number;

    constructor(options: SpatialGridOptions) {
        const b = options.bounds;
        const cols = Math.max(1, Math.ceil((b.maxX - b.minX) / options.cellSize));
        const rows = Math.max(1, Math.ceil((b.maxY - b.minY) / options.cellSize));
        super(options.capacity, cols * rows, options.cellSize, b.minX, b.minY);
        this.cols = cols;
        this.rows = rows;
    }

    protected slotOfCell(cx: number, cy: number): number {
        const x = cx < 0 ? 0 : cx >= this.cols ? this.cols - 1 : cx;
        const y = cy < 0 ? 0 : cy >= this.rows ? this.rows - 1 : cy;
        return y * this.cols + x;
    }
}

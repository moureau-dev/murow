import type { AABB, AABB3 } from './types';

/**
 * A spatial index over 2D axis-aligned boxes keyed by integer id. Points are
 * zero-size boxes (`min === max`). `query` fills a caller-owned array (`results`
 * is cleared first), so it allocates nothing per call.
 */
export interface SpatialIndex {
    /** Number of inserted ids. */
    readonly size: number;
    insert(id: number, bounds: AABB): void;
    remove(id: number): void;
    update(id: number, bounds: AABB): void;
    query(bounds: AABB, results: number[]): void;
    clear(): void;
}

/** The 3D twin of {@link SpatialIndex}, over {@link AABB3}. */
export interface SpatialIndex3D {
    readonly size: number;
    insert(id: number, bounds: AABB3): void;
    remove(id: number): void;
    update(id: number, bounds: AABB3): void;
    query(bounds: AABB3, results: number[]): void;
    clear(): void;
}

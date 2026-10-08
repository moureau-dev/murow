import type { InputSnapshot } from '../../core/input/types';

export interface RaycastHit<H, Point extends readonly number[] = readonly number[]> {
    handle: H;
    distance: number;
    point: Point;
    /** Name of the hitbox part struck, or `null` for a default-bound (box/quad) hit. */
    part: string | null;
}

export interface RaycastOptions<H> {
    filter?: (handle: H) => boolean;
    maxDistance?: number;
}

/** Options for a stateless cast. */
export interface RaycastCastOptions<H, C = unknown> extends RaycastOptions<H> {
    /** Screen coordinates in CSS pixels. Omit to cast from the viewport center. */
    screen?: readonly [x: number, y: number];
    /** Camera to cast with. Omit to use the renderer's camera. */
    camera?: C;
}

export abstract class Raycast<
    H,
    Point extends readonly number[] = readonly number[],
    C = unknown,
> {
    abstract update(input: InputSnapshot): void;
    abstract hit(opts?: RaycastOptions<H>): RaycastHit<H, Point> | null;
    abstract hitAll(opts?: RaycastOptions<H>): readonly RaycastHit<H, Point>[];
    abstract memo(opts: RaycastOptions<H>): RaycastMemo<H, Point>;
    abstract clearMemos(): void;
    /**
     * Pick from explicit screen coordinates, without `update()`.
     *
     * - with a `filter`: the nearest matching hit, or `null`.
     * - without a `filter`: every hit, nearest first.
     *
     * Returned hit objects are pool-backed and valid only until the next
     * `cast`/`update`.
     */
    abstract cast(opts: RaycastCastOptions<H, C> & { filter: (handle: H) => boolean }): RaycastHit<H, Point> | null;
    abstract cast(opts?: RaycastCastOptions<H, C>): readonly RaycastHit<H, Point>[];
}

export abstract class RaycastMemo<H, Point extends readonly number[] = readonly number[]> {
    abstract readonly hits: readonly RaycastHit<H, Point>[];
    abstract readonly first: RaycastHit<H, Point> | null;
    abstract dispose(): void;
}

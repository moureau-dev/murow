import type { InputSnapshot } from '../../core/input/types';

export interface RaycastHit<H, Point extends readonly number[] = readonly number[]> {
    handle: H;
    distance: number;
    point: Point;
}

export interface RaycastOptions<H> {
    filter?: (handle: H) => boolean;
    maxDistance?: number;
}

export abstract class Raycast<H, Point extends readonly number[] = readonly number[]> {
    abstract update(input: InputSnapshot): void;
    abstract hit(opts?: RaycastOptions<H>): RaycastHit<H, Point> | null;
    abstract hitAll(opts?: RaycastOptions<H>): readonly RaycastHit<H, Point>[];
    abstract memo(opts: RaycastOptions<H>): RaycastMemo<H, Point>;
    abstract clearMemos(): void;
}

export abstract class RaycastMemo<H, Point extends readonly number[] = readonly number[]> {
    abstract readonly hits: readonly RaycastHit<H, Point>[];
    abstract readonly first: RaycastHit<H, Point> | null;
    abstract dispose(): void;
}

import type { Component, Entity, World } from 'murow/ecs';
import { SpatialHash, aabbIntersects } from 'murow/core/spatial';
import type { Peer } from '../../ctx';
import type { ServerPlugin } from './plugin';

export interface AoiGridOptions {
    /** Plugin identifier; matches `sync.interest` strings on components. Default `'aoi'`. */
    name?: string;
    /** Uniform-grid cell size (world units). */
    cellSize: number;
    /** AOI radius around each peer (world units). */
    radius: number;
    /** Extra slack on the despawn boundary. Default 0. */
    hysteresisRadius?: number;
    /** Re-index every this many ticks. Default 1 (every tick). */
    interval?: number;
    /** Component holding `{ x, y }` positions used to compute distance. */
    positionComponent: Component<{ x: number; y: number }>;
    /**
     * Optional component holding per-entity half-extents `{ hx, hy }`. When
     * set, interest uses AABB overlap instead of center distance: an entity is
     * visible when its box (`position ± half-extents`) overlaps the peer's box
     * expanded by `radius + hysteresisRadius`. Entities without the component
     * are treated as points.
     */
    boundsComponent?: Component<{ hx: number; hy: number }>;
}

/**
 * Spatial interest plugin. Indexes the position component (or each entity's
 * bounding box) each tick and returns the entities around a peer through
 * `nearby`; `filterSnapshot` builds the interest set.
 */
export class AoiGrid implements ServerPlugin {
    readonly name: string;
    readonly cellSize: number;
    readonly radius: number;
    readonly hysteresisRadius: number;
    readonly interval: number;
    private positionComponent: Component<{ x: number; y: number }>;
    private boundsComponent: Component<{ hx: number; hy: number }> | null;

    private index: SpatialHash | null = null;
    private buckets = 0;
    private readonly bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly viewBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly entityBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly candidates: number[] = [];

    constructor(opts: AoiGridOptions) {
        this.name = opts.name ?? 'aoi';
        this.cellSize = opts.cellSize;
        this.radius = opts.radius;
        this.hysteresisRadius = opts.hysteresisRadius ?? 0;
        this.interval = opts.interval ?? 1;
        this.positionComponent = opts.positionComponent;
        this.boundsComponent = opts.boundsComponent ?? null;
    }

    onTick(world: World): void {
        const max = world.getMaxEntities();
        const list = world.query(this.positionComponent);
        const need = bucketSize(list.length);

        if (this.index === null || this.index.capacity < max || need > this.buckets) {
            this.buckets = Math.max(need, this.index !== null && this.index.capacity >= max ? this.buckets : 0);
            this.index = new SpatialHash({ cellSize: this.cellSize, capacity: max, buckets: this.buckets });
        }
        const index = this.index;

        const fields = world.fields(this.positionComponent);
        const xs = fields.x;
        const ys = fields.y;
        const bf = this.boundsComponent !== null ? world.fields(this.boundsComponent) : null;
        const box = this.box;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let i = 0; i < list.length; i++) {
            const e = list[i]!;
            const x = xs[e]!;
            const y = ys[e]!;
            let hx = 0;
            let hy = 0;
            if (bf !== null && world.has(e, this.boundsComponent!)) {
                hx = bf.hx[e]!;
                hy = bf.hy[e]!;
            }
            const eMinX = x - hx;
            const eMaxX = x + hx;
            const eMinY = y - hy;
            const eMaxY = y + hy;
            box.minX = eMinX; box.maxX = eMaxX;
            box.minY = eMinY; box.maxY = eMaxY;
            index.insert(e, box);
            if (eMinX < minX) minX = eMinX;
            if (eMaxX > maxX) maxX = eMaxX;
            if (eMinY < minY) minY = eMinY;
            if (eMaxY > maxY) maxY = eMaxY;
        }

        const b = this.bounds;
        if (list.length === 0) {
            b.minX = b.minY = b.maxX = b.maxY = 0;
        } else {
            b.minX = minX; b.minY = minY; b.maxX = maxX; b.maxY = maxY;
        }
    }

    /** Entities the AOI spatially manages. */
    covers(world: World, eid: Entity): boolean {
        return world.has(eid, this.positionComponent);
    }

    /** Push the entities within `radius` of the peer's assigned entity onto `out`. */
    nearby(peer: Peer, world: World, out: Entity[]): void {
        const index = this.index;
        if (index === null || index.size === 0) return;

        const fields = world.fields(this.positionComponent);
        const xs = fields.x;
        const ys = fields.y;
        const box = this.box;

        // No assigned entity: the peer sees everything.
        if (peer.entity === -1 || !world.has(peer.entity, this.positionComponent)) {
            const b = this.bounds;
            box.minX = b.minX; box.minY = b.minY; box.maxX = b.maxX; box.maxY = b.maxY;
        } else {
            this.buildViewBox(world, peer, xs, ys);
            const v = this.viewBox;
            box.minX = v.minX; box.minY = v.minY; box.maxX = v.maxX; box.maxY = v.maxY;
        }

        const candidates = this.candidates;
        index.query(box, candidates);

        if (peer.entity === -1 || !world.has(peer.entity, this.positionComponent)) {
            for (let i = 0; i < candidates.length; i++) out.push(candidates[i]!);
            return;
        }

        if (this.boundsComponent !== null) {
            const v = this.viewBox;
            for (let i = 0; i < candidates.length; i++) {
                const e = candidates[i]!;
                if (this.entityOverlaps(world, xs, ys, e, v)) out.push(e);
            }
            return;
        }

        const px = xs[peer.entity]!;
        const py = ys[peer.entity]!;
        const maxR = this.radius + this.hysteresisRadius;
        const maxR2 = maxR * maxR;
        for (let i = 0; i < candidates.length; i++) {
            const e = candidates[i]!;
            const dx = xs[e]! - px;
            const dy = ys[e]! - py;
            if (dx * dx + dy * dy <= maxR2) out.push(e);
        }
    }

    filterSnapshot(
        peer: Peer,
        world: World,
        dirtyEntities: ReadonlyArray<Entity>,
        out: Entity[],
    ): void {
        // No entity assigned yet: everything visible.
        if (peer.entity === -1 || !world.has(peer.entity, this.positionComponent)) {
            for (let i = 0; i < dirtyEntities.length; i++) out.push(dirtyEntities[i]!);
            return;
        }

        const fields = world.fields(this.positionComponent);
        const xs = fields.x;
        const ys = fields.y;

        if (this.boundsComponent !== null) {
            this.buildViewBox(world, peer, xs, ys);
            const v = this.viewBox;
            for (let i = 0; i < dirtyEntities.length; i++) {
                const eid = dirtyEntities[i]!;
                if (!world.has(eid, this.positionComponent)) {
                    out.push(eid);
                    continue;
                }
                if (this.entityOverlaps(world, xs, ys, eid, v)) out.push(eid);
            }
            return;
        }

        const px = xs[peer.entity]!;
        const py = ys[peer.entity]!;
        const maxR = this.radius + this.hysteresisRadius;
        const maxR2 = maxR * maxR;

        for (let i = 0; i < dirtyEntities.length; i++) {
            const eid = dirtyEntities[i]!;
            if (!world.has(eid, this.positionComponent)) {
                // No position: pass through (e.g. global-interest entity).
                out.push(eid);
                continue;
            }
            const dx = xs[eid]! - px;
            const dy = ys[eid]! - py;
            if (dx * dx + dy * dy <= maxR2) out.push(eid);
        }
    }

    /** Peer-centered view box: the peer's box (position ± its own half-extents) expanded by the AOI radius. */
    private buildViewBox(
        world: World,
        peer: Peer,
        xs: ArrayLike<number>,
        ys: ArrayLike<number>,
    ): void {
        const px = xs[peer.entity]!;
        const py = ys[peer.entity]!;
        let hx = 0;
        let hy = 0;
        if (this.boundsComponent !== null && world.has(peer.entity, this.boundsComponent)) {
            const bf = world.fields(this.boundsComponent);
            hx = bf.hx[peer.entity]!;
            hy = bf.hy[peer.entity]!;
        }
        const r = this.radius + this.hysteresisRadius;
        const v = this.viewBox;
        v.minX = px - hx - r; v.maxX = px + hx + r;
        v.minY = py - hy - r; v.maxY = py + hy + r;
    }

    /** Whether entity `e`'s box overlaps the view box. Entities without bounds are points. */
    private entityOverlaps(
        world: World,
        xs: ArrayLike<number>,
        ys: ArrayLike<number>,
        e: Entity,
        view: { minX: number; minY: number; maxX: number; maxY: number },
    ): boolean {
        const x = xs[e]!;
        const y = ys[e]!;
        let hx = 0;
        let hy = 0;
        if (this.boundsComponent !== null && world.has(e, this.boundsComponent)) {
            const bf = world.fields(this.boundsComponent);
            hx = bf.hx[e]!;
            hy = bf.hy[e]!;
        }
        const eb = this.entityBox;
        eb.minX = x - hx; eb.maxX = x + hx;
        eb.minY = y - hy; eb.maxY = y + hy;
        return aabbIntersects(eb, view);
    }
}

function bucketSize(n: number): number {
    let buckets = 1024;
    const want = Math.max(1024, n * 2);
    while (buckets < want && buckets < (1 << 20)) buckets <<= 1;
    return buckets;
}

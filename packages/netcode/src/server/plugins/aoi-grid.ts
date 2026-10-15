import type { Component, Entity, World } from 'murow/ecs';
import { SpatialHash } from 'murow/core/spatial';
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
}

/**
 * Spatial interest plugin. Indexes the position component each tick and returns
 * the entities around a peer through `nearby`; `filterSnapshot` builds the
 * interest set.
 */
export class AoiGrid implements ServerPlugin {
    readonly name: string;
    readonly cellSize: number;
    readonly radius: number;
    readonly hysteresisRadius: number;
    readonly interval: number;
    private positionComponent: Component<{ x: number; y: number }>;

    private index: SpatialHash | null = null;
    private buckets = 0;
    private readonly bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly candidates: number[] = [];

    constructor(opts: AoiGridOptions) {
        this.name = opts.name ?? 'aoi';
        this.cellSize = opts.cellSize;
        this.radius = opts.radius;
        this.hysteresisRadius = opts.hysteresisRadius ?? 0;
        this.interval = opts.interval ?? 1;
        this.positionComponent = opts.positionComponent;
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
        const box = this.box;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let i = 0; i < list.length; i++) {
            const e = list[i]!;
            const x = xs[e]!;
            const y = ys[e]!;
            box.minX = box.maxX = x;
            box.minY = box.maxY = y;
            index.insert(e, box);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
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
            const maxR = this.radius + this.hysteresisRadius;
            const px = xs[peer.entity]!;
            const py = ys[peer.entity]!;
            box.minX = px - maxR; box.minY = py - maxR;
            box.maxX = px + maxR; box.maxY = py + maxR;
        }

        const candidates = this.candidates;
        index.query(box, candidates);

        if (peer.entity === -1 || !world.has(peer.entity, this.positionComponent)) {
            for (let i = 0; i < candidates.length; i++) out.push(candidates[i]!);
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
}

function bucketSize(n: number): number {
    let buckets = 1024;
    const want = Math.max(1024, n * 2);
    while (buckets < want && buckets < (1 << 20)) buckets <<= 1;
    return buckets;
}

import type { Component, Entity, World } from 'murow/ecs';
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
    /** Component holding `{ x, y }` positions used to compute distance. */
    positionComponent: Component<{ x: number; y: number }>;
}

/**
 * Spatial interest plugin. Maintains a uniform grid over the position component
 * (rebuilt each tick in `onTick`) so `nearby` returns the entities around a peer
 * in O(nearby) instead of scanning the whole world. The engine uses `nearby` to
 * bound its per-peer work; `filterSnapshot` remains for the interest set.
 */
export class AoiGrid implements ServerPlugin {
    readonly name: string;
    readonly cellSize: number;
    readonly radius: number;
    readonly hysteresisRadius: number;
    private positionComponent: Component<{ x: number; y: number }>;

    // Uniform grid, CSR layout, rebuilt in place each tick (no steady-state GC).
    private cols = 0;
    private rows = 0;
    private originX = 0;
    private originY = 0;
    private cellStart = new Int32Array(0);   // length cells + 1
    private cellCursor = new Int32Array(0);  // length cells
    private cellItems = new Int32Array(0);   // entity ids, length maxInCell
    private cellOf = new Int32Array(0);      // per-entity cell index, length maxInWorld
    private indexed = 0;

    constructor(opts: AoiGridOptions) {
        this.name = opts.name ?? 'aoi';
        this.cellSize = opts.cellSize;
        this.radius = opts.radius;
        this.hysteresisRadius = opts.hysteresisRadius ?? 0;
        this.positionComponent = opts.positionComponent;
    }

    onTick(world: World): void {
        const fields = world.fields(this.positionComponent);
        const xs = fields.x;
        const ys = fields.y;
        const list = world.query(this.positionComponent);
        const n = list.length;
        this.indexed = 0;
        if (n === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            const e = list[i]!;
            const x = xs[e]!;
            const y = ys[e]!;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }

        const cs = this.cellSize;
        const cols = Math.max(1, Math.floor((maxX - minX) / cs) + 1);
        const rows = Math.max(1, Math.floor((maxY - minY) / cs) + 1);
        const cells = cols * rows;
        this.cols = cols;
        this.rows = rows;
        this.originX = minX;
        this.originY = minY;

        if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
        if (this.cellCursor.length < cells) this.cellCursor = new Int32Array(cells);
        if (this.cellItems.length < n) this.cellItems = new Int32Array(n);
        if (this.cellOf.length < n) this.cellOf = new Int32Array(n);

        const start = this.cellStart;
        const cellOf = this.cellOf;
        start.fill(0, 0, cells + 1);

        for (let i = 0; i < n; i++) {
            const e = list[i]!;
            let cx = Math.floor((xs[e]! - minX) / cs); if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
            let cy = Math.floor((ys[e]! - minY) / cs); if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
            const cell = cy * cols + cx;
            cellOf[i] = cell;
            start[cell + 1]!++;
        }
        for (let i = 0; i < cells; i++) start[i + 1]! += start[i]!;

        const cursor = this.cellCursor;
        cursor.set(start.subarray(0, cells));
        const items = this.cellItems;
        for (let i = 0; i < n; i++) {
            const cell = cellOf[i]!;
            items[cursor[cell]!++] = list[i]!;
        }
        this.indexed = n;
    }

    /** Spatially managed entities are the ones carrying the position component. */
    covers(world: World, eid: Entity): boolean {
        return world.has(eid, this.positionComponent);
    }

    /** Push the entities within `radius` of the peer's assigned entity onto `out`. */
    nearby(peer: Peer, world: World, out: Entity[]): void {
        if (this.indexed === 0) return;

        // No assigned entity: the peer sees everything.
        if (peer.entity === -1 || !world.has(peer.entity, this.positionComponent)) {
            const items = this.cellItems;
            for (let i = 0; i < this.indexed; i++) out.push(items[i]!);
            return;
        }

        const fields = world.fields(this.positionComponent);
        const xs = fields.x;
        const ys = fields.y;
        const px = xs[peer.entity]!;
        const py = ys[peer.entity]!;

        const cs = this.cellSize;
        const cols = this.cols;
        const maxR = this.radius + this.hysteresisRadius;
        const maxR2 = maxR * maxR;

        let c0x = Math.floor((px - maxR - this.originX) / cs); if (c0x < 0) c0x = 0;
        let c1x = Math.floor((px + maxR - this.originX) / cs); if (c1x >= cols) c1x = cols - 1;
        let c0y = Math.floor((py - maxR - this.originY) / cs); if (c0y < 0) c0y = 0;
        let c1y = Math.floor((py + maxR - this.originY) / cs); if (c1y >= this.rows) c1y = this.rows - 1;

        const start = this.cellStart;
        const items = this.cellItems;
        for (let cy = c0y; cy <= c1y; cy++) {
            const row = cy * cols;
            for (let cx = c0x; cx <= c1x; cx++) {
                const idx = row + cx;
                const end = start[idx + 1]!;
                for (let k = start[idx]!; k < end; k++) {
                    const e = items[k]!;
                    const dx = xs[e]! - px;
                    const dy = ys[e]! - py;
                    if (dx * dx + dy * dy <= maxR2) out.push(e);
                }
            }
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

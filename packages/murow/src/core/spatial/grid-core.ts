import type { AABB } from './types';
import type { SpatialIndex } from './spatial-index';

/**
 * Internal base for the uniform-grid indices. Ids must be in `[0, capacity)`.
 */
export abstract class GridCore implements SpatialIndex {
    readonly capacity: number;
    protected readonly slots: number;
    protected readonly cellSize: number;
    protected readonly originX: number;
    protected readonly originY: number;

    private readonly idSlot: Int32Array;
    private readonly slotId: Int32Array;
    private readonly live: Uint8Array;
    private readonly minX: Float32Array;
    private readonly minY: Float32Array;
    private readonly maxX: Float32Array;
    private readonly maxY: Float32Array;
    private readonly freeStack: Int32Array;
    private freeTop: number;
    private readonly liveSlots: Int32Array;
    private readonly slotPos: Int32Array;
    private liveCount = 0;
    private cellStart: Int32Array;
    private cursor: Int32Array;
    private items: Int32Array;
    private readonly stamp: Int32Array;
    private queryStamp = 0;
    private dirty = true;
    private _size = 0;

    constructor(capacity: number, slots: number, cellSize: number, originX = 0, originY = 0) {
        this.capacity = capacity;
        this.slots = slots;
        this.cellSize = cellSize;
        this.originX = originX;
        this.originY = originY;
        this.idSlot = new Int32Array(capacity).fill(-1);
        this.slotId = new Int32Array(capacity);
        this.live = new Uint8Array(capacity);
        this.minX = new Float32Array(capacity);
        this.minY = new Float32Array(capacity);
        this.maxX = new Float32Array(capacity);
        this.maxY = new Float32Array(capacity);
        this.freeStack = new Int32Array(capacity);
        for (let i = 0; i < capacity; i++) this.freeStack[i] = i;
        this.freeTop = capacity;
        this.liveSlots = new Int32Array(capacity);
        this.slotPos = new Int32Array(capacity);
        this.cellStart = new Int32Array(slots + 1);
        this.cursor = new Int32Array(slots);
        this.items = new Int32Array(capacity);
        this.stamp = new Int32Array(capacity).fill(-1);
    }

    get size(): number {
        return this._size;
    }

    /** Map an integer cell coordinate to a bucket slot. */
    protected abstract slotOfCell(cx: number, cy: number): number;

    insert(id: number, bounds: AABB): void {
        if (id < 0 || id >= this.capacity) return;
        let slot = this.idSlot[id]!;
        if (slot === -1) {
            if (this.freeTop === 0) return;
            slot = this.freeStack[--this.freeTop]!;
            this.idSlot[id] = slot;
            this.slotId[slot] = id;
            this.live[slot] = 1;
            this.slotPos[slot] = this.liveCount;
            this.liveSlots[this.liveCount++] = slot;
            this._size++;
        }
        this.minX[slot] = bounds.minX;
        this.minY[slot] = bounds.minY;
        this.maxX[slot] = bounds.maxX;
        this.maxY[slot] = bounds.maxY;
        this.dirty = true;
    }

    update(id: number, bounds: AABB): void {
        this.insert(id, bounds);
    }

    remove(id: number): void {
        if (id < 0 || id >= this.capacity) return;
        const slot = this.idSlot[id]!;
        if (slot === -1) return;
        const pos = this.slotPos[slot]!;
        const last = this.liveSlots[--this.liveCount]!;
        this.liveSlots[pos] = last;
        this.slotPos[last] = pos;
        this.freeStack[this.freeTop++] = slot;
        this.idSlot[id] = -1;
        this.live[slot] = 0;
        this._size--;
        this.dirty = true;
    }

    query(bounds: AABB, out: number[]): void {
        if (this.dirty) this.rebuild();
        out.length = 0;
        const stamp = ++this.queryStamp;
        const start = this.cellStart;
        const items = this.items;
        const stamps = this.stamp;
        const cx0 = this.cellX(bounds.minX);
        const cx1 = this.cellX(bounds.maxX);
        const cy0 = this.cellY(bounds.minY);
        const cy1 = this.cellY(bounds.maxY);
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const slot = this.slotOfCell(cx, cy);
                const end = start[slot + 1]!;
                for (let k = start[slot]!; k < end; k++) {
                    const id = items[k]!;
                    if (stamps[id] !== stamp) { stamps[id] = stamp; out.push(id); }
                }
            }
        }
    }

    /**
     * Fill `out` with the ids in the cells a ray crosses, up to `maxDist`.
     * `(dx, dy)` must be normalized; `maxDist` is in world units. Uses DDA grid
     * traversal, so cost is O(dist / cellSize + candidates). Ids may repeat when
     * buckets collide; `out` is deduplicated.
     */
    queryRay(x0: number, y0: number, dx: number, dy: number, maxDist: number, out: number[]): void {
        if (this.dirty) this.rebuild();
        out.length = 0;
        const stamp = ++this.queryStamp;
        const start = this.cellStart;
        const items = this.items;
        const stamps = this.stamp;
        const cs = this.cellSize;
        const ox = this.originX;
        const oy = this.originY;

        let cx = Math.floor((x0 - ox) / cs);
        let cy = Math.floor((y0 - oy) / cs);

        const stepX = dx >= 0 ? 1 : -1;
        const stepY = dy >= 0 ? 1 : -1;
        const tDeltaX = Math.abs(dx) < 1e-10 ? Infinity : cs / Math.abs(dx);
        const tDeltaY = Math.abs(dy) < 1e-10 ? Infinity : cs / Math.abs(dy);

        let tMaxX = Math.abs(dx) < 1e-10 ? Infinity
            : dx > 0 ? ((cx + 1) * cs + ox - x0) / dx : (x0 - (cx * cs + ox)) / -dx;
        let tMaxY = Math.abs(dy) < 1e-10 ? Infinity
            : dy > 0 ? ((cy + 1) * cs + oy - y0) / dy : (y0 - (cy * cs + oy)) / -dy;

        while (true) {
            const slot = this.slotOfCell(cx, cy);
            const end = start[slot + 1]!;
            for (let k = start[slot]!; k < end; k++) {
                const id = items[k]!;
                if (stamps[id] !== stamp) { stamps[id] = stamp; out.push(id); }
            }
            const nextT = tMaxX < tMaxY ? tMaxX : tMaxY;
            if (nextT > maxDist) break;
            if (tMaxX <= tMaxY) { tMaxX += tDeltaX; cx += stepX; }
            else { tMaxY += tDeltaY; cy += stepY; }
        }
    }

    clear(): void {
        this.idSlot.fill(-1);
        this.live.fill(0);
        for (let i = 0; i < this.capacity; i++) this.freeStack[i] = i;
        this.freeTop = this.capacity;
        this.liveCount = 0;
        this._size = 0;
        this.dirty = true;
    }

    protected cellX(x: number): number {
        return Math.floor((x - this.originX) / this.cellSize);
    }

    protected cellY(y: number): number {
        return Math.floor((y - this.originY) / this.cellSize);
    }

    private rebuild(): void {
        const start = this.cellStart;
        const liveSlots = this.liveSlots;
        const liveCount = this.liveCount;
        start.fill(0, 0, this.slots + 1);

        for (let i = 0; i < liveCount; i++) {
            const s = liveSlots[i]!;
            const cx0 = this.cellX(this.minX[s]!);
            const cx1 = this.cellX(this.maxX[s]!);
            const cy0 = this.cellY(this.minY[s]!);
            const cy1 = this.cellY(this.maxY[s]!);
            for (let cy = cy0; cy <= cy1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) start[this.slotOfCell(cx, cy) + 1]!++;
            }
        }
        for (let i = 0; i < this.slots; i++) start[i + 1]! += start[i]!;

        const total = start[this.slots]!;
        if (this.items.length < total) this.items = new Int32Array(total);

        const cursor = this.cursor;
        for (let i = 0; i < this.slots; i++) cursor[i] = start[i]!;
        const items = this.items;
        for (let i = 0; i < liveCount; i++) {
            const s = liveSlots[i]!;
            const id = this.slotId[s]!;
            const cx0 = this.cellX(this.minX[s]!);
            const cx1 = this.cellX(this.maxX[s]!);
            const cy0 = this.cellY(this.minY[s]!);
            const cy1 = this.cellY(this.maxY[s]!);
            for (let cy = cy0; cy <= cy1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    const slot = this.slotOfCell(cx, cy);
                    items[cursor[slot]!++] = id;
                }
            }
        }
        this.dirty = false;
    }
}

import { FreeList } from '../free-list';
import type { AABB } from './types';
import type { SpatialIndex } from './spatial-index';

/**
 * Internal base for the uniform-grid indices. Records live in typed arrays; the
 * CSR bucket array is rebuilt lazily when the set changes (the same approach as
 * the renderer's batch grids). No `Map`/`Set`, no per-insert allocation. Ids must
 * be in `[0, capacity)`.
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
    private free: FreeList;
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
        this.free = new FreeList(capacity);
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
            const s = this.free.allocate();
            if (s === -1) return;
            slot = s;
            this.idSlot[id] = s;
            this.slotId[s] = id;
            this.live[s] = 1;
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
        this.free.free(slot);
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

    clear(): void {
        this.idSlot.fill(-1);
        this.live.fill(0);
        this.free = new FreeList(this.capacity);
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
        start.fill(0, 0, this.slots + 1);

        for (let s = 0; s < this.capacity; s++) {
            if (this.live[s] === 0) continue;
            this.forEachCell(s, (slot) => { start[slot + 1]!++; });
        }
        for (let i = 0; i < this.slots; i++) start[i + 1]! += start[i]!;

        const total = start[this.slots]!;
        if (this.items.length < total) this.items = new Int32Array(total);

        const cursor = this.cursor;
        cursor.set(start.subarray(0, this.slots));
        const items = this.items;
        for (let s = 0; s < this.capacity; s++) {
            if (this.live[s] === 0) continue;
            const id = this.slotId[s]!;
            this.forEachCell(s, (slot) => { items[cursor[slot]!++] = id; });
        }
        this.dirty = false;
    }

    /** Visit every bucket slot the record in `s` overlaps. */
    private forEachCell(s: number, visit: (slot: number) => void): void {
        const cx0 = this.cellX(this.minX[s]!);
        const cx1 = this.cellX(this.maxX[s]!);
        const cy0 = this.cellY(this.minY[s]!);
        const cy1 = this.cellY(this.maxY[s]!);
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) visit(this.slotOfCell(cx, cy));
        }
    }
}

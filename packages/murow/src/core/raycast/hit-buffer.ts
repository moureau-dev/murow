/**
 * HitBuffer — dimension-agnostic store for a single pick's hits.
 *
 * Structure-of-arrays sorted lazily via an index array (`order`). The
 * backend pushes a sort key (ascending = nearer) and, separately, the
 * `distance` value to expose plus the world hit point it computed. Key
 * and distance differ when ordering isn't by distance: in 2D the key is
 * `-layer` (topmost first) while `distance` stays the real layer, so the
 * public hit never reports a negated value. Queries write into
 * caller-owned arrays; the hot path allocates nothing per frame.
 */
const INITIAL_CAPACITY = 16;

export interface BufferedHit<H, Point extends number[]> {
    handle: H;
    distance: number;
    point: Point;
}

type Filter<H> = (handle: H) => boolean;

export class HitBuffer<H extends { id: number }, Point extends number[]> {
    private handles: (H | null)[] = [];
    private keys = new Float32Array(0);
    private distances = new Float32Array(0);
    private px = new Float32Array(0);
    private py = new Float32Array(0);
    private pz = new Float32Array(0);
    private order = new Uint32Array(0);
    count = 0;
    private capacity = 0;
    private sorted = false;

    private readonly dims: 2 | 3;
    private nearestHit: BufferedHit<H, Point>;

    constructor(dims: 2 | 3) {
        this.dims = dims;
        this.nearestHit = this.makeHit();
    }

    private makeHit(): BufferedHit<H, Point> {
        const point = (this.dims === 2 ? [0, 0] : [0, 0, 0]) as Point;
        return { handle: null as unknown as H, distance: 0, point };
    }

    reset(): void {
        this.count = 0;
        this.sorted = false;
    }

    /**
     * `key` orders the hit (ascending = nearer); `distance` is the value
     * the public hit reports. They differ only when ordering isn't by
     * distance (e.g. 2D layer). `distance` defaults to `key`.
     */
    push(handle: H, key: number, x: number, y: number, z = 0, distance = key): void {
        const slot = this.count;
        if (slot >= this.capacity) this.grow(slot + 1);
        this.handles[slot] = handle;
        this.keys[slot] = key;
        this.distances[slot] = distance;
        this.px[slot] = x;
        this.py[slot] = y;
        this.pz[slot] = z;
        this.order[slot] = slot;
        this.count = slot + 1;
        this.sorted = false;
    }

    nearest(filter: Filter<H> | undefined, cap: number): BufferedHit<H, Point> | null {
        let bestSlot = -1;
        let bestKey = Infinity;
        for (let s = 0; s < this.count; s++) {
            const k = this.keys[s];
            if (k > cap || k >= bestKey) continue;
            const h = this.handles[s]!;
            if (filter && !filter(h)) continue;
            bestKey = k;
            bestSlot = s;
        }
        return bestSlot === -1 ? null : this.fill(this.nearestHit, bestSlot);
    }

    collectInto(out: BufferedHit<H, Point>[], filter: Filter<H> | undefined, cap: number): void {
        this.ensureSorted();
        let n = 0;
        for (let i = 0; i < this.count; i++) {
            const slot = this.order[i];
            const k = this.keys[slot];
            if (k > cap) break;
            const h = this.handles[slot]!;
            if (filter && !filter(h)) continue;
            const target = out[n] ?? (out[n] = this.makeHit());
            this.fill(target, slot);
            n++;
        }
        out.length = n;
    }

    containsId(id: number): boolean {
        for (let s = 0; s < this.count; s++) {
            const h = this.handles[s];
            if (h !== null && h.id === id) return true;
        }
        return false;
    }

    private fill(target: BufferedHit<H, Point>, slot: number): BufferedHit<H, Point> {
        target.handle = this.handles[slot]!;
        target.distance = this.distances[slot];
        target.point[0] = this.px[slot];
        target.point[1] = this.py[slot];
        if (this.dims === 3) target.point[2] = this.pz[slot];
        return target;
    }

    private grow(n: number): void {
        const cap = Math.max(n, this.capacity * 2, INITIAL_CAPACITY);
        this.handles.length = cap;

        const keys = new Float32Array(cap); keys.set(this.keys); this.keys = keys;
        const distances = new Float32Array(cap); distances.set(this.distances); this.distances = distances;
        const px = new Float32Array(cap); px.set(this.px); this.px = px;
        const py = new Float32Array(cap); py.set(this.py); this.py = py;
        const pz = new Float32Array(cap); pz.set(this.pz); this.pz = pz;
        const order = new Uint32Array(cap); order.set(this.order); this.order = order;

        this.capacity = cap;
    }

    // Insertion sort over `order`: count is the number of hits in one pick
    // (typically a handful), where this beats Array.sort's comparator
    // overhead and allocations. Revisit for volume queries.
    private ensureSorted(): void {
        if (this.sorted) return;
        const order = this.order;
        const keys = this.keys;
        for (let i = 1; i < this.count; i++) {
            const cur = order[i];
            const k = keys[cur];
            let j = i - 1;
            while (j >= 0 && keys[order[j]] > k) {
                order[j + 1] = order[j];
                j--;
            }
            order[j + 1] = cur;
        }
        this.sorted = true;
    }
}

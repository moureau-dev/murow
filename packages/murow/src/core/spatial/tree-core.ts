/**
 * Internal base for the dynamic trees (`Quadtree`/`Octree`). Ids must be in
 * `[0, capacity)`.
 */
export abstract class TreeCore {
    readonly capacity: number;
    protected readonly dim: number;
    protected readonly branching: number;
    protected readonly maxItems: number;
    protected readonly maxDepth: number;
    private readonly maxNodes: number;

    private readonly nodeMin: Float32Array;
    private readonly nodeMax: Float32Array;
    private readonly nodeDepth: Uint8Array;
    private readonly nodeHead: Int32Array;
    private readonly nodeCount: Int32Array;
    private readonly nodeChild: Int32Array;
    private readonly nodeFree: Int32Array;
    private nodeFreeTop: number;

    private readonly entId: Int32Array;
    private readonly entNode: Int32Array;
    private readonly entPrev: Int32Array;
    private readonly entNext: Int32Array;
    private readonly entMin: Float32Array;
    private readonly entMax: Float32Array;
    private readonly idEntry: Int32Array;
    private readonly entFree: Int32Array;
    private entFreeTop: number;

    private readonly rootMin: number[];
    private readonly rootMax: number[];
    private _size = 0;

    protected constructor(opts: {
        capacity: number;
        dim: number;
        branching: number;
        maxItems: number;
        maxDepth: number;
        rootMin: number[];
        rootMax: number[];
        maxNodes?: number;
    }) {
        this.capacity = opts.capacity;
        this.dim = opts.dim;
        this.branching = opts.branching;
        this.maxItems = opts.maxItems;
        this.maxDepth = opts.maxDepth;
        this.rootMin = opts.rootMin;
        this.rootMax = opts.rootMax;

        const maxNodes = opts.maxNodes ?? Math.max(64, opts.capacity * 2);
        this.maxNodes = maxNodes;
        this.nodeMin = new Float32Array(maxNodes * this.dim);
        this.nodeMax = new Float32Array(maxNodes * this.dim);
        this.nodeDepth = new Uint8Array(maxNodes);
        this.nodeHead = new Int32Array(maxNodes).fill(-1);
        this.nodeCount = new Int32Array(maxNodes);
        this.nodeChild = new Int32Array(maxNodes * this.branching).fill(-1);
        this.nodeFree = new Int32Array(Math.max(1, maxNodes - 1));
        for (let i = 0; i < maxNodes - 1; i++) this.nodeFree[i] = i + 1;
        this.nodeFreeTop = maxNodes - 1;

        this.entId = new Int32Array(opts.capacity);
        this.entNode = new Int32Array(opts.capacity).fill(-1);
        this.entPrev = new Int32Array(opts.capacity).fill(-1);
        this.entNext = new Int32Array(opts.capacity).fill(-1);
        this.entMin = new Float32Array(opts.capacity * this.dim);
        this.entMax = new Float32Array(opts.capacity * this.dim);
        this.entFree = new Int32Array(opts.capacity);
        for (let i = 0; i < opts.capacity; i++) this.entFree[i] = i;
        this.entFreeTop = opts.capacity;
        this.idEntry = new Int32Array(opts.capacity).fill(-1);

        this.initRoot();
    }

    get size(): number {
        return this._size;
    }

    protected insertFlat(id: number, min: Float32Array, max: Float32Array): void {
        if (id < 0 || id >= this.capacity) return;
        let e = this.idEntry[id]!;
        if (e !== -1) {
            this.unlinkEntry(e);
        } else {
            if (this.entFreeTop === 0) return;
            e = this.entFree[--this.entFreeTop]!;
            this.idEntry[id] = e;
            this.entPrev[e] = -1;
            this.entNext[e] = -1;
            this.entNode[e] = -1;
            this._size++;
        }
        const d = this.dim;
        for (let k = 0; k < d; k++) {
            this.entMin[e * d + k] = min[k]!;
            this.entMax[e * d + k] = max[k]!;
        }
        this.entId[e] = id;
        this.insertEntry(0, e);
    }

    protected queryFlat(min: Float32Array, max: Float32Array, out: number[]): void {
        out.length = 0;
        this.queryNode(0, min, max, out);
    }

    remove(id: number): boolean {
        if (id < 0 || id >= this.capacity) return false;
        const e = this.idEntry[id]!;
        if (e === -1) return false;
        this.unlinkEntry(e);
        this.entFree[this.entFreeTop++] = e;
        this.idEntry[id] = -1;
        this._size--;
        return true;
    }

    clear(): void {
        this._size = 0;
        this.nodeHead.fill(-1);
        this.nodeCount.fill(0);
        this.nodeChild.fill(-1);
        this.nodeDepth.fill(0);
        this.entNode.fill(-1);
        this.entPrev.fill(-1);
        this.entNext.fill(-1);
        this.idEntry.fill(-1);
        for (let i = 0; i < this.maxNodes - 1; i++) this.nodeFree[i] = i + 1;
        this.nodeFreeTop = this.maxNodes - 1;
        for (let i = 0; i < this.capacity; i++) this.entFree[i] = i;
        this.entFreeTop = this.capacity;
        this.initRoot();
    }

    private initRoot(): void {
        const d = this.dim;
        for (let k = 0; k < d; k++) {
            this.nodeMin[k] = this.rootMin[k]!;
            this.nodeMax[k] = this.rootMax[k]!;
        }
        this.nodeDepth[0] = 0;
        this.nodeHead[0] = -1;
        this.nodeCount[0] = 0;
        for (let i = 0; i < this.branching; i++) this.nodeChild[i] = -1;
    }

    private insertEntry(node: number, e: number): void {
        const base = node * this.branching;
        if (this.nodeChild[base] !== -1) {
            const ci = this.childContaining(node, e);
            if (ci >= 0) { this.insertEntry(this.nodeChild[base + ci]!, e); return; }
            this.linkEntry(node, e);
            return;
        }
        this.linkEntry(node, e);
        if (this.nodeCount[node]! > this.maxItems && this.nodeDepth[node]! < this.maxDepth) {
            this.subdivide(node);
        }
    }

    private subdivide(node: number): void {
        if (this.nodeFreeTop < this.branching) return;
        const d = this.dim;
        const base = node * this.branching;
        const depth = this.nodeDepth[node]! + 1;
        const nb = node * d;

        for (let i = 0; i < this.branching; i++) {
            const c = this.nodeFree[--this.nodeFreeTop]!;
            this.nodeDepth[c] = depth;
            this.nodeHead[c] = -1;
            this.nodeCount[c] = 0;
            const cb = c * this.branching;
            for (let j = 0; j < this.branching; j++) this.nodeChild[cb + j] = -1;
            for (let k = 0; k < d; k++) {
                const mid = (this.nodeMin[nb + k]! + this.nodeMax[nb + k]!) / 2;
                if (i & (1 << k)) {
                    this.nodeMin[c * d + k] = mid;
                    this.nodeMax[c * d + k] = this.nodeMax[nb + k]!;
                } else {
                    this.nodeMin[c * d + k] = this.nodeMin[nb + k]!;
                    this.nodeMax[c * d + k] = mid;
                }
            }
            this.nodeChild[base + i] = c;
        }

        let e = this.nodeHead[node]!;
        this.nodeHead[node] = -1;
        this.nodeCount[node] = 0;
        while (e !== -1) {
            const next = this.entNext[e]!;
            this.entPrev[e] = -1;
            this.entNext[e] = -1;
            this.entNode[e] = -1;
            const ci = this.childContaining(node, e);
            if (ci >= 0) this.insertEntry(this.nodeChild[base + ci]!, e);
            else this.linkEntry(node, e);
            e = next;
        }
    }

    private linkEntry(node: number, e: number): void {
        this.entNode[e] = node;
        this.entPrev[e] = -1;
        this.entNext[e] = this.nodeHead[node]!;
        if (this.nodeHead[node] !== -1) this.entPrev[this.nodeHead[node]!] = e;
        this.nodeHead[node] = e;
        this.nodeCount[node]!++;
    }

    private unlinkEntry(e: number): void {
        const node = this.entNode[e]!;
        const prev = this.entPrev[e]!;
        const next = this.entNext[e]!;
        if (prev === -1) this.nodeHead[node] = next;
        else this.entNext[prev] = next;
        if (next !== -1) this.entPrev[next] = prev;
        this.entPrev[e] = -1;
        this.entNext[e] = -1;
        this.entNode[e] = -1;
        this.nodeCount[node]!--;
    }

    private childContaining(node: number, e: number): number {
        const d = this.dim;
        const nb = node * d;
        const eb = e * d;
        let index = 0;
        for (let k = 0; k < d; k++) {
            const mid = (this.nodeMin[nb + k]! + this.nodeMax[nb + k]!) / 2;
            if (this.entMax[eb + k]! <= mid) continue;
            if (this.entMin[eb + k]! >= mid) index |= (1 << k);
            else return -1;
        }
        return index;
    }

    private queryNode(node: number, min: Float32Array, max: Float32Array, out: number[]): void {
        const d = this.dim;
        for (let e = this.nodeHead[node]!; e !== -1; e = this.entNext[e]!) {
            const b = e * d;
            let hit = true;
            for (let k = 0; k < d; k++) {
                if (this.entMax[b + k]! < min[k]! || this.entMin[b + k]! > max[k]!) { hit = false; break; }
            }
            if (hit) out.push(this.entId[e]!);
        }
        const base = node * this.branching;
        for (let i = 0; i < this.branching; i++) {
            const c = this.nodeChild[base + i]!;
            if (c === -1) break;
            const nb = c * d;
            let hit = true;
            for (let k = 0; k < d; k++) {
                if (this.nodeMax[nb + k]! < min[k]! || this.nodeMin[nb + k]! > max[k]!) { hit = false; break; }
            }
            if (hit) this.queryNode(c, min, max, out);
        }
    }
}

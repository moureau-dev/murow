import { type AABB3 } from '../types';
import type { SpatialIndex3D } from '../spatial-index';

export interface OctreeOptions {
    /** Root region. Boxes outside are still inserted but always tested at the root. */
    bounds: AABB3;
    /** Entries per node before it subdivides. Default 8. */
    maxItems?: number;
    /** Maximum subdivision depth. Default 8. */
    maxDepth?: number;
}

interface Entry {
    id: number;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

interface Node {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    depth: number;
    entries: Entry[];
    children: Node[] | null;
}

/**
 * Dynamic octree — the 3D twin of {@link Quadtree}. A node subdivides into 8
 * octants past `maxItems` (down to `maxDepth`); an entry that fits entirely in
 * one octant descends, otherwise it stays at the node. Each id lives in exactly
 * one node, so `query` never duplicates.
 */
export class Octree implements SpatialIndex3D {
    private readonly maxItems: number;
    private readonly maxDepth: number;
    private root: Node;
    private count = 0;

    constructor(options: OctreeOptions) {
        this.maxItems = options.maxItems ?? 8;
        this.maxDepth = options.maxDepth ?? 8;
        const b = options.bounds;
        this.root = {
            minX: b.minX, minY: b.minY, minZ: b.minZ,
            maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ,
            depth: 0, entries: [], children: null,
        };
    }

    get size(): number {
        return this.count;
    }

    insert(id: number, bounds: AABB3): void {
        if (!this.remove(id)) this.count++;
        this.insertInto(this.root, {
            id,
            minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ,
            maxX: bounds.maxX, maxY: bounds.maxY, maxZ: bounds.maxZ,
        });
    }

    update(id: number, bounds: AABB3): void {
        this.remove(id);
        this.insert(id, bounds);
    }

    remove(id: number): boolean {
        const removed = removeFrom(this.root, id);
        if (removed) this.count--;
        return removed;
    }

    query(bounds: AABB3, results: number[]): void {
        results.length = 0;
        queryNode(this.root, bounds, results);
    }

    clear(): void {
        this.root.entries.length = 0;
        this.root.children = null;
        this.count = 0;
    }

    private insertInto(node: Node, entry: Entry): void {
        if (node.children !== null) {
            const ci = childContaining(node, entry);
            if (ci >= 0) { this.insertInto(node.children[ci]!, entry); return; }
            node.entries.push(entry);
            return;
        }
        node.entries.push(entry);
        if (node.entries.length > this.maxItems && node.depth < this.maxDepth) {
            this.split(node);
            const kept: Entry[] = [];
            const entries = node.entries;
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i]!;
                const idx = childContaining(node, e);
                if (idx >= 0) this.insertInto(node.children![idx]!, e);
                else kept.push(e);
            }
            node.entries = kept;
        }
    }

    private split(node: Node): void {
        const mx = (node.minX + node.maxX) / 2;
        const my = (node.minY + node.maxY) / 2;
        const mz = (node.minZ + node.maxZ) / 2;
        const d = node.depth + 1;
        const children: Node[] = [];
        for (let i = 0; i < 8; i++) {
            children.push({
                minX: (i & 1) ? mx : node.minX,
                minY: (i & 2) ? my : node.minY,
                minZ: (i & 4) ? mz : node.minZ,
                maxX: (i & 1) ? node.maxX : mx,
                maxY: (i & 2) ? node.maxY : my,
                maxZ: (i & 4) ? node.maxZ : mz,
                depth: d, entries: [], children: null,
            });
        }
        node.children = children;
    }
}

function childContaining(node: Node, e: Entry): number {
    const mx = (node.minX + node.maxX) / 2;
    const my = (node.minY + node.maxY) / 2;
    const mz = (node.minZ + node.maxZ) / 2;
    const lowX = e.maxX <= mx;
    const highX = e.minX >= mx;
    const lowY = e.maxY <= my;
    const highY = e.minY >= my;
    const lowZ = e.maxZ <= mz;
    const highZ = e.minZ >= mz;
    if (lowX && lowY && lowZ) return 0;
    if (highX && lowY && lowZ) return 1;
    if (lowX && highY && lowZ) return 2;
    if (highX && highY && lowZ) return 3;
    if (lowX && lowY && highZ) return 4;
    if (highX && lowY && highZ) return 5;
    if (lowX && highY && highZ) return 6;
    if (highX && highY && highZ) return 7;
    return -1;
}

function queryNode(node: Node, b: AABB3, results: number[]): void {
    for (let i = 0; i < node.entries.length; i++) {
        const e = node.entries[i]!;
        if (e.minX <= b.maxX && e.maxX >= b.minX
            && e.minY <= b.maxY && e.maxY >= b.minY
            && e.minZ <= b.maxZ && e.maxZ >= b.minZ) {
            results.push(e.id);
        }
    }
    const children = node.children;
    if (children !== null) {
        for (let i = 0; i < 8; i++) {
            const c = children[i]!;
            if (c.minX <= b.maxX && c.maxX >= b.minX
                && c.minY <= b.maxY && c.maxY >= b.minY
                && c.minZ <= b.maxZ && c.maxZ >= b.minZ) {
                queryNode(c, b, results);
            }
        }
    }
}

function removeFrom(node: Node, id: number): boolean {
    const entries = node.entries;
    for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.id === id) {
            entries[i] = entries[entries.length - 1]!;
            entries.pop();
            return true;
        }
    }
    const children = node.children;
    if (children !== null) {
        for (let i = 0; i < 8; i++) if (removeFrom(children[i]!, id)) return true;
    }
    return false;
}

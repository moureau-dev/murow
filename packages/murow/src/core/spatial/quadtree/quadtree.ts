import { type AABB } from '../types';
import type { SpatialIndex } from '../spatial-index';

export interface QuadtreeOptions {
    /** Root region. Boxes outside are still inserted but always tested at the root. */
    bounds: AABB;
    /** Entries per node before it subdivides. Default 8. */
    maxItems?: number;
    /** Maximum subdivision depth. Default 8. */
    maxDepth?: number;
}

interface Entry {
    id: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

interface Node {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    depth: number;
    entries: Entry[];
    children: Node[] | null;
}

/**
 * Dynamic quadtree. A node subdivides past `maxItems` (down to `maxDepth`); an
 * entry that fits entirely in one child descends, otherwise it stays at the
 * node. Adapts to clustered data better than a uniform grid, at the cost of
 * node objects. Each id lives in exactly one node, so `query` never duplicates.
 */
export class Quadtree implements SpatialIndex {
    private readonly maxItems: number;
    private readonly maxDepth: number;
    private root: Node;
    private count = 0;

    constructor(options: QuadtreeOptions) {
        this.maxItems = options.maxItems ?? 8;
        this.maxDepth = options.maxDepth ?? 8;
        const b = options.bounds;
        this.root = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, depth: 0, entries: [], children: null };
    }

    get size(): number {
        return this.count;
    }

    insert(id: number, bounds: AABB): void {
        if (!this.remove(id)) this.count++;
        this.insertInto(this.root, { id, minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY });
    }

    update(id: number, bounds: AABB): void {
        this.remove(id);
        this.insert(id, bounds);
    }

    remove(id: number): boolean {
        const removed = removeFrom(this.root, id);
        if (removed) this.count--;
        return removed;
    }

    query(bounds: AABB, results: number[]): void {
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
        const midX = (node.minX + node.maxX) / 2;
        const midY = (node.minY + node.maxY) / 2;
        const d = node.depth + 1;
        node.children = [
            { minX: node.minX, minY: node.minY, maxX: midX, maxY: midY, depth: d, entries: [], children: null },
            { minX: midX, minY: node.minY, maxX: node.maxX, maxY: midY, depth: d, entries: [], children: null },
            { minX: node.minX, minY: midY, maxX: midX, maxY: node.maxY, depth: d, entries: [], children: null },
            { minX: midX, minY: midY, maxX: node.maxX, maxY: node.maxY, depth: d, entries: [], children: null },
        ];
    }
}

function childContaining(node: Node, e: Entry): number {
    const midX = (node.minX + node.maxX) / 2;
    const midY = (node.minY + node.maxY) / 2;
    const left = e.maxX <= midX;
    const right = e.minX >= midX;
    const bottom = e.maxY <= midY;
    const top = e.minY >= midY;
    if (left && bottom) return 0;
    if (right && bottom) return 1;
    if (left && top) return 2;
    if (right && top) return 3;
    return -1;
}

function queryNode(node: Node, b: AABB, results: number[]): void {
    for (let i = 0; i < node.entries.length; i++) {
        const e = node.entries[i]!;
        if (e.minX <= b.maxX && e.maxX >= b.minX && e.minY <= b.maxY && e.maxY >= b.minY) {
            results.push(e.id);
        }
    }
    const children = node.children;
    if (children !== null) {
        for (let i = 0; i < 4; i++) {
            const c = children[i]!;
            if (c.minX <= b.maxX && c.maxX >= b.minX && c.minY <= b.maxY && c.maxY >= b.minY) {
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
        for (let i = 0; i < 4; i++) if (removeFrom(children[i]!, id)) return true;
    }
    return false;
}

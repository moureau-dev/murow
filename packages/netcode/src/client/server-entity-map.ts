import type { Entity } from 'murow/ecs';

/**
 * Read-only view of the server-id -> local-entity mapping. Strategies depend on
 * this, not the concrete map, so `Map<number, Entity>` also satisfies it.
 */
export interface ServerEntityLookup {
    get(serverId: number): Entity | undefined;
}

/**
 * Dense server-id -> local-entity map. Server entity ids are small,
 * non-negative integers (`FreeList` slots), so a plain array gives O(1) lookup
 * with no hashing and no per-entry allocation. Ids at or beyond `maxEntities`
 * fall back to a `Map`, so a sparse or oversized id space cannot blow up memory.
 */
export class ServerEntityMap implements ServerEntityLookup {
    private readonly dense: number[];
    private overflow: Map<number, Entity> | null = null;
    private _size = 0;

    constructor(maxEntities: number) {
        this.dense = new Array<number>(maxEntities).fill(-1);
    }

    get size(): number {
        return this._size;
    }

    get(serverId: number): Entity | undefined {
        if (serverId < 0) return undefined;
        if (serverId < this.dense.length) {
            const v = this.dense[serverId]!;
            return v < 0 ? undefined : v;
        }
        return this.overflow?.get(serverId);
    }

    has(serverId: number): boolean {
        return this.get(serverId) !== undefined;
    }

    set(serverId: number, local: Entity): void {
        if (serverId < this.dense.length) {
            if (this.dense[serverId]! < 0) this._size++;
            this.dense[serverId] = local;
            return;
        }
        const map = (this.overflow ??= new Map<number, Entity>());
        if (!map.has(serverId)) this._size++;
        map.set(serverId, local);
    }

    delete(serverId: number): boolean {
        if (serverId < this.dense.length) {
            if (this.dense[serverId]! < 0) return false;
            this.dense[serverId] = -1;
            this._size--;
            return true;
        }
        const map = this.overflow;
        if (map === undefined || !map.delete(serverId)) return false;
        this._size--;
        return true;
    }

    clear(): void {
        this.dense.fill(-1);
        this.overflow?.clear();
        this._size = 0;
    }

    entries(): IterableIterator<[number, Entity]> {
        return this[Symbol.iterator]();
    }

    *[Symbol.iterator](): IterableIterator<[number, Entity]> {
        for (let i = 0; i < this.dense.length; i++) {
            const v = this.dense[i]!;
            if (v >= 0) yield [i, v];
        }
        if (this.overflow !== null) yield* this.overflow;
    }
}

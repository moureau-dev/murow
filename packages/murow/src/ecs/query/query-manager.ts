import { Component } from "../components/component";
import { ComponentManager } from "../components/component-manager";
import { EntityManager, type Entity } from "../entity/entity-manager";
import { setHas, setInsert, setRemove, type EntitySet } from "../entity/entity-set";

/** A maintained query result: an `EntitySet` plus the mask it matches. */
interface QueryCache extends EntitySet {
    mask: number[];
}

/**
 * Owns the per-query result caches, maintained incrementally on every
 * structural change (spawn/despawn/add/remove) instead of being invalidated and
 * rescanned. Membership is validated by `buffer[positions[e]] === e`, so caches
 * never need resetting.
 *
 * Reads the per-entity masks and member lists from `ComponentManager` and the
 * alive list from `EntityManager`; a single-component query aliases that
 * component's member list directly (no scan, no extra storage).
 */
export class QueryManager {
    private queryCaches: Record<string, QueryCache> = {};
    private queryCacheList: QueryCache[] = [];
    private queryMaskCache: Record<string, number[]> = {};
    private readonly maxEntities: number;

    constructor(
        private readonly componentManager: ComponentManager,
        private readonly entityManager: EntityManager,
    ) {
        this.maxEntities = entityManager.getMaxEntities();
    }

    query(components: Component<any>[]): readonly Entity[] {
        const requiredMask = this.getQueryMask(components);
        if (requiredMask === null) return [];

        const maskKey = this.maskToKey(requiredMask);
        return this.getQueryCache(maskKey, requiredMask).buffer;
    }

    queryByMaskKey(maskKey: string, requiredMask: number[]): readonly Entity[] {
        return this.getQueryCache(maskKey, requiredMask).buffer;
    }

    getQueryMaskKey(components: Component<any>[]): string {
        const mask = this.getQueryMask(components);
        return mask ? this.maskToKey(mask) : "";
    }

    /**
     * Get or compute the query bitmask (one 32-bit word per 32 components),
     * caching by the sorted set of component world-indices. Returns null when a
     * component is not registered.
     */
    getQueryMask(components: Component<any>[]): number[] | null {
        let maxIndex = -1;
        const indices: number[] = [];

        for (const component of components) {
            const index = component.__worldIndex;
            if (index === undefined) return null;
            indices.push(index);
            if (index > maxIndex) maxIndex = index;
        }

        const cacheKey = indices.sort((a, b) => a - b).join(",");
        const cached = this.queryMaskCache[cacheKey];
        if (cached) return cached;

        const numWords = Math.floor(maxIndex / 32) + 1;
        const requiredMask: number[] = new Array(numWords).fill(0);
        for (const index of indices) {
            requiredMask[index >>> 5] |= 1 << (index & 31);
        }

        this.queryMaskCache[cacheKey] = requiredMask;
        return requiredMask;
    }

    private maskToKey(mask: number[]): string {
        let key = "";
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] !== 0) {
                key += `${i}:${mask[i]!.toString(36)},`;
            }
        }
        return key;
    }

    /** Decode the component world-indices set in a query mask. */
    private maskIndices(mask: number[]): number[] {
        const indices: number[] = [];
        for (let w = 0; w < mask.length; w++) {
            const word = mask[w]!;
            if (word === 0) continue;
            for (let b = 0; b < 32; b++) {
                if ((word & (1 << b)) !== 0) indices.push(w * 32 + b);
            }
        }
        return indices;
    }

    /**
     * Return the maintained cache for a query mask, registering it the first
     * time it is seen. A single-component query aliases that component's member
     * list directly (no scan, no extra storage, not tracked in `queryCacheList`).
     * A multi-component query seeds its one-time scan from the smallest member
     * list among its components, not all alive entities, then is kept current
     * incrementally so subsequent reads are O(1).
     */
    private getQueryCache(maskKey: string, mask: number[]): QueryCache {
        let qc = this.queryCaches[maskKey];
        if (qc !== undefined) return qc;

        const indices = this.maskIndices(mask);

        if (indices.length === 1) {
            const members = this.componentManager.getMembers(indices[0]!);
            qc = { mask, buffer: members.buffer, positions: members.positions };
            this.queryCaches[maskKey] = qc;
            return qc;
        }

        qc = { mask, buffer: [], positions: new Int32Array(this.maxEntities) };
        this.queryCaches[maskKey] = qc;
        this.queryCacheList.push(qc);

        let leadBuf: Uint32Array | Entity[] = this.entityManager.aliveBuffer;
        let leadLen = this.entityManager.count;
        for (let k = 0; k < indices.length; k++) {
            const candidate = this.componentManager.getMembers(indices[k]!).buffer;
            if (candidate.length < leadLen) {
                leadBuf = candidate;
                leadLen = candidate.length;
            }
        }

        const buffer = qc.buffer;
        const positions = qc.positions;
        let writeIdx = 0;
        for (let i = 0; i < leadLen; i++) {
            const entity = leadBuf[i]!;
            if (this.componentManager.matchesComponentMask(entity, mask)) {
                positions[entity] = writeIdx;
                buffer[writeIdx++] = entity;
            }
        }
        buffer.length = writeIdx;

        return qc;
    }

    /** Gaining a component can only newly satisfy a query, never break one. */
    onComponentAdded(entity: Entity): void {
        const list = this.queryCacheList;
        for (let i = 0; i < list.length; i++) {
            const qc = list[i]!;
            if (
                !setHas(qc, entity) &&
                this.componentManager.matchesComponentMask(entity, qc.mask)
            ) {
                setInsert(qc, entity);
            }
        }
    }

    /** Losing a component can only break a query match, never create one. */
    onComponentRemoved(entity: Entity): void {
        const list = this.queryCacheList;
        for (let i = 0; i < list.length; i++) {
            const qc = list[i]!;
            if (
                setHas(qc, entity) &&
                !this.componentManager.matchesComponentMask(entity, qc.mask)
            ) {
                setRemove(qc, entity);
            }
        }
    }

    /** A despawned entity leaves every multi-component query buffer it was in. */
    onEntityDespawned(entity: Entity): void {
        const list = this.queryCacheList;
        for (let i = 0; i < list.length; i++) {
            const qc = list[i]!;
            if (setHas(qc, entity)) setRemove(qc, entity);
        }
    }
}

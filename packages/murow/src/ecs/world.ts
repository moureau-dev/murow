import type { ArrayFromField, Schema } from "../core/binary-codec";
import { generateId } from "../core/generate-id";
import { Component } from "./component";
import { ComponentStore } from "./component-store";
import { EntityHandle } from "./entity-handle";
import { WorldSystems } from "./world-systems";
import { serializeEntity, restoreEntity, entityByteSize } from "./world-codec";

/**
 * Configuration for creating a World
 */
export interface WorldConfig {
  /** Maximum number of entities that can exist simultaneously */
  maxEntities?: number;

  /** Component types to register */
  components: Component<any>[];
}

/**
 * Entity ID type (just a number, indexing into component arrays)
 */
export type Entity = number;

/**
 * A dense set of entities with O(1) membership. `buffer` is the dense list;
 * `positions` maps entity -> its index in `buffer`, valid only when
 * `buffer[positions[e]] === e` (so stale entries are harmless, no reset needed).
 */
interface EntitySet {
    buffer: Entity[];
    positions: Int32Array;
}

/** A maintained query result: an `EntitySet` plus the mask it matches. */
interface QueryCache extends EntitySet {
    mask: number[];
}

/**
 * World manages entities and their components.
 * Provides efficient ECS storage using typed arrays.
 *
 * Performance optimizations:
 * - Array iteration instead of Set for 2-5x faster queries
 * - Query bitmask caching for repeated queries
 * - Array-indexed component stores for O(1) access
 * - Pre-allocated ring buffer for entity ID reuse
 *
 * @example
 * ```typescript
 * const world = new World({
 *   maxEntities: 10000,
 *   components: [Transform, Health, Velocity]
 * });
 *
 * const entity = world.spawn();
 * world.add(entity, Transform, { x: 100, y: 200, rotation: 0 });
 * world.add(entity, Health, { current: 100, max: 100 });
 *
 * // Query entities
 * for (const entity of world.query(Transform, Velocity)) {
 *   const transform = world.get(entity, Transform);
 *   const velocity = world.get(entity, Velocity);
 *   // transform is readonly, use update() to modify
 *   world.update(entity, Transform, {
 *     x: transform.x + velocity.vx,
 *     y: transform.y + velocity.vy
 *   });
 * }
 * ```
 */
export class World extends WorldSystems {
    private maxEntities: number;
    private nextEntityId: number = 0;

    // Entity ID reuse (ring buffer for O(1) push/pop)
    private freeEntityIds: Uint32Array;
    private freeEntityHead: number = 0;
    private freeEntityTail: number = 0;
    private freeEntityCount: number = 0;
    private freeEntityMask: number = 0; // Bitwise AND mask for power-of-2 modulo

    // Entity storage: Array for fast iteration, bitmask for O(1) alive checks
    private aliveEntitiesArray: Entity[] = [];
    private aliveEntitiesIndices: Uint32Array; // Index lookup for O(1) despawn
    private aliveEntityFlags: Uint8Array; // 1 byte per entity for alive check

    // Component system (array-indexed for O(1) access)
    public componentStoresArray: (ComponentStore<any> | undefined)[];
    private componentMasks: Uint32Array[]; // Dynamic array of bitmask words (32 components per word)
    private componentMasks0!: Uint32Array; // Fast path: cached reference to first word (most common case)
    private numMaskWords: number = 0; // Number of allocated mask words

    // Component registry (direct index stored on component - zero lookup cost!)
    private components: Component<any>[] = [];

    // Per-query result caches, maintained incrementally on every structural
    // change (spawn/despawn/add/remove) instead of invalidated and rescanned.
    // `positions` is a sparse map entity -> index in `buffer`; membership is
    // validated by `buffer[positions[e]] === e`, so it never needs resetting.
    private queryCaches: Record<string, QueryCache> = {};
    private queryCacheList: QueryCache[] = [];

    // Per-component entity lists ("entities that have component i"), maintained
    // on every add/remove/despawn. Single-component queries return these
    // directly; multi-component query registration scans the smallest of them
    // instead of all alive entities. Indexed by component world index.
    private componentMembers: EntitySet[] = [];

    // Query mask cache (avoid recomputing masks for same component combinations)
    private queryMaskCache: Record<string, number[]> = {};

    // Despawn tracker: collects entity IDs despawned this tick.
    // Call flushDespawned() after processing to reset.
    private despawnedBuffer: Uint32Array;
    private despawnedCount: number = 0;

    /**
     * Per-component dirty bitmask, indexed by [componentIndex][entity>>>5].
     * `null` for components without `__sync` metadata: no overhead when
     * networking isn't in play. Higher-level packages might read these
     * to build per-peer snapshot deltas.
     */
    private dirtyBitsByComponent: (Uint32Array | null)[] = [];

    /**
     * Per-component field bundle: a frozen object whose keys are the
     * component's field names and whose values are the same typed-array
     * references returned by `getFieldArray`. Built once at registration,
     * shared forever — `world.fields(C)` returns the same object on every
     * call (zero garbage). Indexed by `component.__worldIndex`.
     */
    private fieldsByComponent: Record<string, Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array>[] = [];

    // Debug ID
    private worldId = generateId({ prefix: "world_" });

    constructor(config: WorldConfig) {
        super();
        this.maxEntities = config.maxEntities ?? 10000;

        // Calculate number of mask words needed (1 word per 32 components)
        this.numMaskWords = Math.ceil(config.components.length / 32);

        // Allocate separate Uint32Array for each mask word
        this.componentMasks = [];
        for (let i = 0; i < this.numMaskWords; i++) {
            this.componentMasks.push(new Uint32Array(this.maxEntities));
        }

        // Cache first word for fast path (most games use <32 components)
        if (this.numMaskWords > 0) {
            this.componentMasks0 = this.componentMasks[0];
        }

        // Round up to next power of 2 for ring buffer (enables bitwise modulo)
        const ringBufferSize = Math.pow(
            2,
            Math.ceil(Math.log2(this.maxEntities)),
        );
        this.freeEntityIds = new Uint32Array(ringBufferSize);
        this.freeEntityMask = ringBufferSize - 1; // For x % size → x & mask

        // Pre-allocate index lookup for O(1) despawn
        this.aliveEntitiesIndices = new Uint32Array(this.maxEntities);

        // Pre-allocate alive flags for O(1) alive checks
        this.aliveEntityFlags = new Uint8Array(this.maxEntities);

        // Pre-allocate despawn tracker
        this.despawnedBuffer = new Uint32Array(this.maxEntities);

        // Pre-allocate arrays for component stores
        this.componentStoresArray = new Array(config.components.length);

        // Per-component dirty bitmap allocator: one Uint32Array per
        // synced component (32 entities per word).
        const dirtyWordsPerComponent = Math.ceil(this.maxEntities / 32);

        // Pre-allocate field-bundle array
        this.fieldsByComponent = new Array(config.components.length);

        // Register components
        config.components.forEach((component, index) => {
            this.components.push(component);
            // Store index directly on component for O(1) access (no Map lookup!)
            component.__worldIndex = index;

            // Create component store with selected backend
            const store = new ComponentStore(component, this.maxEntities);
            this.componentStoresArray[index] = store;

            // Per-component entity list, maintained as components are added/removed.
            this.componentMembers[index] = { buffer: [], positions: new Int32Array(this.maxEntities) };

            // Synced components get a dirty bitmap; others stay null.
            this.dirtyBitsByComponent[index] =
                component.__sync !== undefined
                    ? new Uint32Array(dirtyWordsPerComponent)
                    : null;

            // Build the field bundle: { fieldName: typedArray } for every
            // field in the schema. Frozen so users can't accidentally
            // reassign field arrays. The typed arrays themselves are not
            // frozen — writes go straight to their underlying memory.
            const bundle: Record<string, Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array> = {};
            for (let i = 0; i < component.fieldNames.length; i++) {
                const fieldName = component.fieldNames[i];
                bundle[fieldName as string] = store.getFieldArray(fieldName);
            }
            Object.freeze(bundle);
            this.fieldsByComponent[index] = bundle;
        });
    }

    /**
     * Register a component type with the world after construction.
     *
     * Allocates the component's store, field bundle, and (for synced
     * components) dirty bitmap, and widens the per-entity mask words when the
     * new component crosses a 32-bit boundary. Existing entities keep their
     * data and existing query results stay valid: no entity has the new
     * component yet.
     *
     * Idempotent for a component already registered in this world. Returns the
     * component so calls can chain, e.g. `world.fields(world.addComponent(C))`.
     */
    addComponent<T extends object, S extends Schema<T>>(
        component: Component<T, S>,
    ): Component<T, S> {
        const existing = component.__worldIndex;
        if (existing !== undefined && this.components[existing] === component) {
            return component;
        }

        const index = this.components.length;
        this.components.push(component);
        component.__worldIndex = index;

        // Widen the mask words if this index lands in a new 32-bit word.
        const requiredWords = (index >>> 5) + 1;
        while (this.componentMasks.length < requiredWords) {
            this.componentMasks.push(new Uint32Array(this.maxEntities));
        }
        this.numMaskWords = this.componentMasks.length;
        this.componentMasks0 = this.componentMasks[0];

        const store = new ComponentStore(component, this.maxEntities);
        this.componentStoresArray[index] = store;

        this.componentMembers[index] = { buffer: [], positions: new Int32Array(this.maxEntities) };

        this.dirtyBitsByComponent[index] =
            component.__sync !== undefined
                ? new Uint32Array(Math.ceil(this.maxEntities / 32))
                : null;

        const bundle: Record<string, Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array> = {};
        for (let i = 0; i < component.fieldNames.length; i++) {
            const fieldName = component.fieldNames[i];
            bundle[fieldName as string] = store.getFieldArray(fieldName);
        }
        Object.freeze(bundle);
        this.fieldsByComponent[index] = bundle;

        return component;
    }

    /**
     * Get component index (O(1) - stored directly on component)
     */
    private getComponentIndex(component: Component<any>): number {
        const index = component.__worldIndex;
        if (index === undefined) {
            const registered = this.components.map((c) => c.name).join(", ");
            throw new Error(
                `Component ${component.name} not registered in World[${this.worldId}]. ` +
                    `Registered components: [${registered}]. ` +
                    `Did you forget to include it in the WorldConfig?`,
            );
        }
        return index;
    }

    /**
     * Set a bit in the bitmask for an entity
     */
    private setComponentBit(entity: Entity, componentIndex: number): void {
        const wordIndex = componentIndex >>> 5; // Which word (div 32)
        const bitIndex = componentIndex & 31; // Which bit in word (mod 32)
        this.componentMasks[wordIndex][entity] |= 1 << bitIndex;
    }

    /**
     * Clear a bit in the bitmask for an entity
     */
    private clearComponentBit(entity: Entity, componentIndex: number): void {
        const wordIndex = componentIndex >>> 5; // Which word (div 32)
        const bitIndex = componentIndex & 31; // Which bit in word (mod 32)
        this.componentMasks[wordIndex][entity] &= ~(1 << bitIndex);
    }

    /**
     * Check if a bit is set in the bitmask for an entity
     */
    private hasComponentBit(entity: Entity, componentIndex: number): boolean {
        const wordIndex = componentIndex >>> 5; // Which word (div 32)
        const bitIndex = componentIndex & 31; // Which bit in word (mod 32)
        return (this.componentMasks[wordIndex][entity] & (1 << bitIndex)) !== 0;
    }

    /**
     * Clear all component bits for an entity
     */
    private clearAllComponentBits(entity: Entity): void {
        // Fast paths for common cases (avoids loop overhead)
        if (this.numMaskWords === 1) {
            this.componentMasks0[entity] = 0;
        } else if (this.numMaskWords === 2) {
            this.componentMasks0[entity] = 0;
            this.componentMasks[1][entity] = 0;
        } else if (this.numMaskWords === 3) {
            this.componentMasks0[entity] = 0;
            this.componentMasks[1][entity] = 0;
            this.componentMasks[2][entity] = 0;
        } else {
            // General case for 4+ words
            for (let i = 0; i < this.numMaskWords; i++) {
                this.componentMasks[i][entity] = 0;
            }
        }
    }

    /**
     * Check if entity matches the required component mask
     * Returns true if entity has all required components
     *
     * Optimized for common case: most games use <32 components,
     * so we only need to check the first word
     */
    private matchesComponentMask(entity: Entity, mask: number[]): boolean {
        const len = mask.length;

        // Fast path: single word (most common - <32 components)
        if (len === 1) {
            return (this.componentMasks0[entity] & mask[0]) === mask[0];
        }

        // Unrolled for 2 words (32-63 components)
        if (len === 2) {
            return (
                (this.componentMasks0[entity] & mask[0]) === mask[0] &&
                (this.componentMasks[1][entity] & mask[1]) === mask[1]
            );
        }

        // Unrolled for 3 words (64-95 components)
        if (len === 3) {
            return (
                (this.componentMasks0[entity] & mask[0]) === mask[0] &&
                (this.componentMasks[1][entity] & mask[1]) === mask[1] &&
                (this.componentMasks[2][entity] & mask[2]) === mask[2]
            );
        }

        // Unrolled for 4 words (96-127 components)
        if (len === 4) {
            return (
                (this.componentMasks0[entity] & mask[0]) === mask[0] &&
                (this.componentMasks[1][entity] & mask[1]) === mask[1] &&
                (this.componentMasks[2][entity] & mask[2]) === mask[2] &&
                (this.componentMasks[3][entity] & mask[3]) === mask[3]
            );
        }

        // General case for 5+ words (rare)
        for (let i = 0; i < len; i++) {
            if ((this.componentMasks[i][entity] & mask[i]) !== mask[i]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get or compute query bitmask
     * Returns array of numbers (one 32-bit mask per word)
     *
     * Caches masks to avoid recomputation for frequently used component combinations
     */
    private getQueryMask(components: Component<any>[]): number[] | null {
        // Find max component index to determine how many words we need
        let maxIndex = -1;
        const indices: number[] = [];

        for (const component of components) {
            const index = component.__worldIndex;
            if (index === undefined) return null; // Invalid mask sentinel
            indices.push(index);
            if (index > maxIndex) maxIndex = index;
        }

        // Cache key from the unique world indices (sorted for order independence)
        const cacheKey = indices.sort((a, b) => a - b).join(",");

        // Check cache first
        const cached = this.queryMaskCache[cacheKey];
        if (cached) return cached;

        // Calculate number of words needed
        const numWords = Math.floor(maxIndex / 32) + 1;
        const requiredMask: number[] = new Array(numWords).fill(0);

        // Set bits for each component (direct index access - no lookups!)
        for (const index of indices) {
            const wordIndex = index >>> 5; // div 32
            const bitIndex = index & 31; // mod 32
            requiredMask[wordIndex] |= 1 << bitIndex;
        }

        // Cache the mask for future queries
        this.queryMaskCache[cacheKey] = requiredMask;

        return requiredMask;
    }

    /**
     * Convert mask array to a hash key for caching
     */
    private maskToKey(mask: number[]): string {
        let key = "";
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] !== 0) {
                key += `${i}:${mask[i].toString(36)},`;
            }
        }
        return key;
    }

    /**
     * Internal: Get query mask key for a set of components.
     * Used by SystemBuilder for precomputing query keys.
     * @internal
     */
    private _getQueryMaskKey(components: Component<any>[]): string {
        const mask = this.getQueryMask(components);
        return mask ? this.maskToKey(mask) : "";
    }

    /**
     * Internal: Query entities by precomputed mask key and mask.
     * Used by ExecutableSystem for fast queries without mask recomputation.
     * @internal
     */
    private _queryByMaskKey(
        maskKey: string,
        requiredMask: number[],
    ): readonly Entity[] {
        return this.getQueryCache(maskKey, requiredMask).buffer;
    }

    /**
     * Return the maintained cache for a query mask, registering it the first
     * time it is seen. A single-component query aliases that component's member
     * list directly (no scan, no extra storage). A multi-component query seeds
     * its one-time scan from the smallest member list among its components, not
     * all alive entities. After registration the buffer is kept current
     * incrementally, so subsequent reads are O(1) with no rescan.
     */
    private getQueryCache(maskKey: string, mask: number[]): QueryCache {
        let qc = this.queryCaches[maskKey];
        if (qc !== undefined) return qc;

        const indices = this.maskIndices(mask);

        // let the caching games begin

        // Single component: the result IS that component's member list. Alias
        // its buffer/positions; component-list maintenance keeps it current, so
        // it must NOT also be tracked in queryCacheList.
        if (indices.length === 1) {
            const members = this.componentMembers[indices[0]!]!;
            qc = { mask, buffer: members.buffer, positions: members.positions };
            this.queryCaches[maskKey] = qc;
            return qc;
        }

        qc = { mask, buffer: [], positions: new Int32Array(this.maxEntities) };
        this.queryCaches[maskKey] = qc;
        this.queryCacheList.push(qc);

        // Lead with the smallest member list among the queried components
        // and not of scanning all alive entities.
        let lead: Entity[] = this.aliveEntitiesArray;
        for (let k = 0; k < indices.length; k++) {
            const candidate = this.componentMembers[indices[k]!]!.buffer;
            if (candidate.length < lead.length) lead = candidate;
        }

        const buffer = qc.buffer;
        const positions = qc.positions;
        let writeIdx = 0;
        for (let i = 0; i < lead.length; i++) {
            const entity = lead[i]!;

            if (this.matchesComponentMask(entity, mask)) {
                positions[entity] = writeIdx;
                buffer[writeIdx++] = entity;
            }
        }

        buffer.length = writeIdx;

        return qc;
    }

    /** Decode the component world-indices set in a query mask. */
    private maskIndices(mask: number[]): number[] {
        const indices: number[] = [];

        for (let w = 0; w < mask.length; w++) {
            const word = mask[w];
            if (word === 0) continue;

            for (let b = 0; b < 32; b++) {
                const bit = 1 << b;
                const isSet = (word & bit) !== 0;
                const entityIndex = w * 32 + b;
                if (isSet) indices.push(entityIndex);
            }
        }

        return indices;
    }

    private setHas(set: EntitySet, entity: Entity): boolean {
        const idx = set.positions[entity];
        return idx < set.buffer.length && set.buffer[idx] === entity;
    }

    private setInsert(set: EntitySet, entity: Entity): void {
        set.positions[entity] = set.buffer.length;
        set.buffer.push(entity);
    }

    private setRemove(set: EntitySet, entity: Entity): void {
        const buffer = set.buffer;
        const idx = set.positions[entity];
        const last = buffer.length - 1;
        const lastEntity = buffer[last]!;
        buffer[idx] = lastEntity;
        set.positions[lastEntity] = idx;
        buffer.length = last;
    }

    /** Gaining a component can only newly satisfy a query, never break one. */
    private onComponentAdded(entity: Entity): void {
        const list = this.queryCacheList;
        for (let i = 0; i < list.length; i++) {
            const qc = list[i]!;
            if (!this.setHas(qc, entity) && this.matchesComponentMask(entity, qc.mask)) {
                this.setInsert(qc, entity);
            }
        }
    }

    /** Losing a component can only break a query match, never create one. */
    private onComponentRemoved(entity: Entity): void {
        const list = this.queryCacheList;
        for (let i = 0; i < list.length; i++) {
            const qc = list[i]!;
            if (this.setHas(qc, entity) && !this.matchesComponentMask(entity, qc.mask)) {
                this.setRemove(qc, entity);
            }
        }
    }

    /** A despawned entity leaves every multi-component query buffer it was in. */
    private onEntityDespawned(entity: Entity): void {
        const list = this.queryCacheList;
        for (let i = 0; i < list.length; i++) {
            const qc = list[i]!;
            if (this.setHas(qc, entity)) this.setRemove(qc, entity);
        }
    }

    /**
     * Spawn a new entity.
     * Returns the entity ID.
     */
    spawn(): Entity {
        // Hot path: allocate new ID (most common case, no branching)
        let id = this.nextEntityId;

        // Cold path: reuse freed ID if available
        if (this.freeEntityCount > 0) {
            id = this.freeEntityIds[this.freeEntityTail];
            this.freeEntityTail =
                (this.freeEntityTail + 1) & this.freeEntityMask;
            this.freeEntityCount--;
        } else {
            this.nextEntityId++;
        }

        // Bounds check (unlikely to fail in normal operation)
        if (id >= this.maxEntities) {
            throw new Error(
                `Maximum entities (${this.maxEntities}) reached. ` +
                    `Current alive: ${this.aliveEntitiesArray.length}, ` +
                    `Free list: ${this.freeEntityCount}`,
            );
        }

        // Fast path: setup entity (no branches)
        this.aliveEntityFlags[id] = 1;
        this.aliveEntitiesIndices[id] = this.aliveEntitiesArray.length;
        this.aliveEntitiesArray.push(id);
        this.clearAllComponentBits(id);

        // A fresh entity has no components yet, so it matches no query: query
        // caches only change once components are added (see onComponentAdded).

        return id;
    }

    /**
     * Despawn an entity, removing all its components.
     * The entity ID will be reused.
     */
    despawn(entity: Entity): void {
        if (this.aliveEntityFlags[entity] === 0) {
            return; // Already despawned
        }

        // Track this despawn
        this.despawnedBuffer[this.despawnedCount++] = entity;

        this.aliveEntityFlags[entity] = 0;

        // Remove from array (swap with last for O(1) removal)
        const idx = this.aliveEntitiesIndices[entity];
        const last = this.aliveEntitiesArray.length - 1;

        if (idx !== last) {
            // Swap with last element
            const lastEntity = this.aliveEntitiesArray[last];
            this.aliveEntitiesArray[idx] = lastEntity;
            this.aliveEntitiesIndices[lastEntity] = idx;
        }

        this.aliveEntitiesArray.pop();

        // Clear all components for this entity
        const stores = this.componentStoresArray;
        const componentCount = this.components.length;
        for (let i = 0; i < componentCount; i++) {
            if (this.hasComponentBit(entity, i)) {
                stores[i]!.clear(entity);
                this.setRemove(this.componentMembers[i]!, entity);
            }
        }

        this.clearAllComponentBits(entity);

        // Push to free list
        this.freeEntityIds[this.freeEntityHead] = entity;
        this.freeEntityHead = (this.freeEntityHead + 1) & this.freeEntityMask; // Bitwise AND instead of modulo
        this.freeEntityCount++;

        // Maintain query caches: the entity leaves every query buffer it was in.
        this.onEntityDespawned(entity);
    }

    /**
     * Check if an entity is alive
     */
    isAlive(entity: Entity): boolean {
        return this.aliveEntityFlags[entity] === 1;
    }

    /**
     * Get entities despawned since the last flushDespawned() call.
     * Returns a subarray view — zero allocations.
     */
    getDespawned(): Uint32Array {
        return this.despawnedBuffer.subarray(0, this.despawnedCount);
    }

    /**
     * Clear the despawn tracker. Call once per tick after processing despawns.
     */
    flushDespawned(): void {
        this.despawnedCount = 0;
    }

    /**
     * Mark an entity dirty for a given component index. No-op for
     * components without `__sync` metadata. Called internally by every
     * write path (`add`, `set`, `update`, `system-builder` field setters).
     */
    markDirty(entity: Entity, componentIndex: number): void {
        const bits = this.dirtyBitsByComponent[componentIndex];
        if (bits === null || bits === undefined) return;
        bits[entity >>> 5] |= 1 << (entity & 31);
    }

    /**
     * Test whether an entity is currently marked dirty for a component.
     * Used by snapshot builders.
     */
    isDirty(entity: Entity, component: Component<any>): boolean {
        const index = component.__worldIndex;
        if (index === undefined) return false;
        const bits = this.dirtyBitsByComponent[index];
        if (bits === null || bits === undefined) return false;
        return (bits[entity >>> 5] & (1 << (entity & 31))) !== 0;
    }

    /**
     * Clear the dirty bit for an entity/component pair. Called by the
     * snapshot builder after a delta for the entity has been acknowledged
     * by all peers.
     */
    clearDirty(entity: Entity, component: Component<any>): void {
        const index = component.__worldIndex;
        if (index === undefined) return;
        const bits = this.dirtyBitsByComponent[index];
        if (bits === null || bits === undefined) return;
        bits[entity >>> 5] &= ~(1 << (entity & 31));
    }

    /**
     * Iterate dirty entities for a synced component. Calls `cb` for each
     * entity whose dirty bit is set. Returns immediately for unsynced
     * components.
     */
    forEachDirty(component: Component<any>, cb: (entity: Entity) => void): void {
        const index = component.__worldIndex;
        if (index === undefined) return;
        const bits = this.dirtyBitsByComponent[index];
        if (bits === null || bits === undefined) return;
        for (let w = 0; w < bits.length; w++) {
            let word = bits[w];
            if (word === 0) continue;
            const base = w << 5;
            while (word !== 0) {
                const bit = word & -word; // lowest set bit
                const lsb = 31 - Math.clz32(bit);
                cb(base + lsb);
                word ^= bit;
            }
        }
    }

    /**
     * Clear all dirty bits across all components. Usually the snapshot
     * pipeline clears bits per-entity as it processes them.
     */
    clearAllDirty(): void {
        for (let i = 0; i < this.dirtyBitsByComponent.length; i++) {
            const bits = this.dirtyBitsByComponent[i];
            if (bits !== null && bits !== undefined) bits.fill(0);
        }
    }

    /**
     * Add a component to an entity with initial data.
     */
    add<T extends object>(
        entity: Entity,
        component: Component<T>,
        data: T,
    ): void {
        if (this.aliveEntityFlags[entity] === 0) {
            throw new Error(
                `Cannot add component ${component.name} to entity ${entity}: ` +
                    `entity is not alive (was it despawned?). ` +
                    `Current alive entities: ${this.aliveEntitiesArray.length}`,
            );
        }

        const index = this.getComponentIndex(component);
        const store = this.componentStoresArray[index]!;

        this.setComponentBit(entity, index);
        store.set(entity, data);
        this.markDirty(entity, index);

        // Maintain the component's member list and any queries it now satisfies.
        const members = this.componentMembers[index]!;
        if (!this.setHas(members, entity)) this.setInsert(members, entity);
        this.onComponentAdded(entity);
    }

    /**
     * Remove a component from an entity.
     */
    remove<T extends object>(entity: Entity, component: Component<T>): void {
        const index = component.__worldIndex;
        if (index === undefined) return;

        this.clearComponentBit(entity, index);

        const store = this.componentStoresArray[index];
        if (store) {
            store.clear(entity);
        }

        // Maintain the component's member list and any queries it no longer satisfies.
        const members = this.componentMembers[index]!;
        if (this.setHas(members, entity)) this.setRemove(members, entity);
        this.onComponentRemoved(entity);
    }

    /**
     * Check if an entity has a component.
     */
    has<T extends object>(entity: Entity, component: Component<T>): boolean {
        const index = component.__worldIndex;
        if (index === undefined) return false;

        return this.hasComponentBit(entity, index);
    }

    /**
     * Get a component's data for an entity.
     * Returns a READONLY reusable object (zero allocations).
     *
     * ⚠️ IMPORTANT: The returned object is reused and will be overwritten on the next get().
     * To modify, use set() or update() instead.
     * To keep multiple components, use getMutable() or spread operator.
     *
     * @example
     * // ✅ CORRECT: Use immediately
     * const t = world.get(entity, Transform);
     * console.log(t.x, t.y);
     *
     * // ❌ WRONG: Storing reference
     * const t1 = world.get(entity1, Transform);
     * const t2 = world.get(entity2, Transform); // t1 is now corrupted!
     *
     * // ✅ CORRECT: Copy if you need to keep
     * const t1 = { ...world.get(entity1, Transform) };
     * const t2 = { ...world.get(entity2, Transform) };
     */
    get<T extends object>(
        entity: Entity,
        component: Component<T>,
    ): Readonly<T> {
        const index = this.getComponentIndex(component);

        if (!this.hasComponentBit(entity, index)) {
            const entityComponents = this.getEntityComponentNames(entity);
            throw new Error(
                `Cannot get component ${component.name} from entity ${entity}: ` +
                    `entity does not have this component. ` +
                    `Entity has: [${entityComponents.join(", ")}]. ` +
                    `Did you forget to call world.add()?`,
            );
        }

        return this.componentStoresArray[index]!.get(entity);
    }

    /**
     * Get a mutable copy of component data.
     * Use this when you need to modify and keep the data.
     *
     * Note: This allocates a new object. Use sparingly in hot paths.
     */
    getMutable<T extends object>(entity: Entity, component: Component<T>): T {
        const index = this.getComponentIndex(component);

        if (!this.hasComponentBit(entity, index)) {
            throw new Error(
                `Entity ${entity} does not have component ${component.name}`,
            );
        }

        return this.componentStoresArray[index]!.getMutable(entity);
    }

    /**
     * Set a component's data for an entity.
     * Overwrites all fields.
     */
    set<T extends object>(
        entity: Entity,
        component: Component<T>,
        data: T,
    ): void {
        const index = this.getComponentIndex(component);

        if (!this.hasComponentBit(entity, index)) {
            throw new Error(
                `Cannot set component ${component.name} on entity ${entity}: ` +
                    `entity does not have this component. Use add() first.`,
            );
        }

        this.componentStoresArray[index]!.set(entity, data);
        this.markDirty(entity, index);
    }

    /**
     * Update specific fields of a component.
     * More efficient than get + modify + set.
     *
     * @example
     * // ✅ GOOD: Partial update
     * world.update(entity, Transform, { x: 150 });
     *
     * // ❌ BAD: Full get/set for single field
     * const t = world.getMutable(entity, Transform);
     * t.x = 150;
     * world.set(entity, Transform, t);
     */
    update<T extends object>(
        entity: Entity,
        component: Component<T>,
        partial: Partial<T>,
    ): void {
        const index = this.getComponentIndex(component);

        if (!this.hasComponentBit(entity, index)) {
            throw new Error(
                `Entity ${entity} does not have component ${component.name}`,
            );
        }

        this.componentStoresArray[index]!.update(entity, partial);
        this.markDirty(entity, index);
    }

    /**
     * Query entities that have all specified components.
     * Returns a readonly array for zero-allocation iteration.
     *
     * Uses reusable buffers and direct bitmask checks for maximum performance.
     * The returned array is reused on subsequent queries with the same mask.
     *
     * @example
     * ```typescript
     * for (const entity of world.query(Transform, Velocity)) {
     *   const t = world.get(entity, Transform);
     *   const v = world.get(entity, Velocity);
     *   world.update(entity, Transform, {
     *     x: t.x + v.vx * deltaTime,
     *     y: t.y + v.vy * deltaTime
     *   });
     * }
     * ```
     */
    query(...components: Component<any>[]): readonly Entity[] {
        const requiredMask = this.getQueryMask(components);
        if (requiredMask === null) return []; // Component not registered

        const maskKey = this.maskToKey(requiredMask);
        return this.getQueryCache(maskKey, requiredMask).buffer;
    }

    /**
     * Get all alive entity IDs.
     *
     * ⚠️ WARNING: The returned array is a direct reference and should not be modified.
     * For a safe copy, use [...world.getEntities()].
     */
    getEntities(): readonly Entity[] {
        return this.aliveEntitiesArray;
    }

    /**
     * Get the number of alive entities.
     */
    getEntityCount(): number {
        return this.aliveEntitiesArray.length;
    }

    /**
     * Get the maximum number of entities.
     */
    getMaxEntities(): number {
        return this.maxEntities;
    }

    /**
     * Get all registered components.
     */
    getComponents(): readonly Component<any>[] {
        return this.components;
    }

    /**
     * Get component names for an entity (for debugging)
     */
    private getEntityComponentNames(entity: Entity): string[] {
        const result: string[] = [];

        for (let i = 0; i < this.components.length; i++) {
            if (this.hasComponentBit(entity, i)) {
                result.push(this.components[i].name);
            }
        }

        return result;
    }

    /**
     * Serialize an entity's components to a new buffer. Defaults to every
     * registered component; pass a subset to limit it. Restore with the same
     * component list.
     */
    serialize(entityId: Entity, components: Component<any>[] = this.components): Uint8Array {
        const buffer = new Uint8Array(entityByteSize(this, entityId, components));
        serializeEntity(this, entityId, components, new DataView(buffer.buffer), 0);
        return buffer;
    }

    /**
     * Restore an entity's components from a buffer produced by `serialize`.
     * Defaults to every registered component; pass the same subset used to
     * serialize. Adds components the entity does not have.
     */
    restore(entityId: Entity, data: Uint8Array, components: Component<any>[] = this.components): void {
        restoreEntity(this, entityId, components, new DataView(data.buffer, data.byteOffset, data.byteLength), 0);
    }

    /**
     * Write an entity's components into `dv` at `offset`. Returns the offset
     * past the written bytes. For the hot path: the caller owns and reuses
     * the DataView across entities.
     */
    writeEntity(entityId: Entity, components: Component<any>[], dv: DataView, offset: number): number {
        return serializeEntity(this, entityId, components, dv, offset);
    }

    /**
     * Read an entity's components from `dv` at `offset`. Returns the offset
     * past the read bytes.
     */
    readEntity(entityId: Entity, components: Component<any>[], dv: DataView, offset: number): number {
        return restoreEntity(this, entityId, components, dv, offset);
    }

    /**
     * Get direct access to a component field's TypedArray for maximum performance.
     * This bypasses the get/update API for ~3-4x faster access in hot paths.
     *
     * ⚠️ ADVANCED API: Use with caution!
     * - No bounds checking
     * - No type safety
     * - You must ensure entities have the component
     * - Direct array mutation bypasses any safety mechanisms
     *
     * @example
     * ```typescript
     * // High-performance system (bitECS-style)
     * const transformX = world.getFieldArray(Transform, 'x');
     * const transformY = world.getFieldArray(Transform, 'y');
     * const velocityVx = world.getFieldArray(Velocity, 'vx');
     * const velocityVy = world.getFieldArray(Velocity, 'vy');
     *
     * for (const entity of world.query(Transform, Velocity)) {
     *   transformX[entity] += velocityVx[entity] * deltaTime;
     *   transformY[entity] += velocityVy[entity] * deltaTime;
     * }
     * ```
     */
    getFieldArray<T extends object>(
        component: Component<T>,
        fieldName: keyof T,
    ): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array {
        const index = this.getComponentIndex(component);
        return this.componentStoresArray[index]!.getFieldArray(fieldName);
    }

    /**
     * Get a typed-array bundle for every field of a component.
     *
     * Returns the same frozen object on every call - built once at component
     * registration and shared forever. Each field name maps to its underlying
     * typed array, with the EXACT element type inferred from the schema:
     * `f32 -> Float32Array`, `u8 -> Uint8Array`, `u16 -> Uint16Array`, etc.
     * No casts needed in caller code.
     *
     * Use this when you want RAW-speed per-entity reads/writes without the
     * `world.update({...})` allocation + `for...in` overhead. Bypasses dirty
     * tracking: for networked components, see `ctx.fields()` in `murow/netcode`
     * which auto-marks dirty, or call `world.markDirty(entity, index)` yourself.
     *
     * @example
     * ```ts
     * const pos = world.fields(Position);   // pos.x, pos.z typed as Float32Array
     * pos.x[entity] += velocity.x * dt;
     * pos.z[entity] += velocity.z * dt;
     * ```
     */
    fields<T extends object, S extends Schema<T>>(
        component: Component<T, S>,
    ): Readonly<{ [K in keyof S]: ArrayFromField<S[K]> }> {
        const index = this.getComponentIndex(component);
        return this.fieldsByComponent[index] as Readonly<{ [K in keyof S]: ArrayFromField<S[K]> }>;
    }

    /**
     * Create an EntityHandle wrapper for fluent API usage.
     *
     * EntityHandle provides a chainable interface for entity operations with zero runtime overhead.
     * Modern JIT compilers inline these simple method calls, making them identical to raw World API.
     *
     * @param entityId - Entity ID to wrap
     * @returns EntityHandle for fluent operations
     *
     * @example
     * ```typescript
     * // Fluent API with chaining
     * const player = world.entity(world.spawn())
     *   .add(Transform, { x: 0, y: 0, rotation: 0 })
     *   .add(Health, { current: 100, max: 100 })
     *   .add(Velocity, { vx: 0, vy: 0 });
     *
     * // Use the handle
     * player.update(Transform, { x: 10 });
     * const health = player.get(Health);
     *
     * // Mix with raw API
     * world.add(player.id, Armor, { value: 50 });
     * ```
     */
    entity(entityId: Entity): EntityHandle {
        return new EntityHandle(this, entityId);
    }
}

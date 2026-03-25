import { generateId } from "../core/generate-id";
import { Component } from "./component";
import { ComponentStore } from "./component-store";
import { EntityHandle } from "./entity-handle";
import { WorldSystems } from "./world-systems";

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

    // Query result cache (reusable buffers for zero allocations)
    private queryResultBuffers: Record<string, Entity[]> = {}; // Now keyed by string hash

    // Persistent query cache (invalidated only on archetype changes)
    private archetypeVersion: number = 0; // Increments on spawn/despawn/add/remove
    private queryCacheVersions: Record<string, number> = {}; // Keyed by mask hash

    // Query mask cache (avoid recomputing masks for same component combinations)
    private queryMaskCache: Record<string, number[]> = {};

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

        // Pre-allocate arrays for component stores
        this.componentStoresArray = new Array(config.components.length);

        // Register components
        config.components.forEach((component, index) => {
            this.components.push(component);
            // Store index directly on component for O(1) access (no Map lookup!)
            component.__worldIndex = index;

            // Create component store with selected backend
            const store = new ComponentStore(component, this.maxEntities);
            this.componentStoresArray[index] = store;
        });
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
        // Create cache key from component names (sorted for consistency)
        const cacheKey = components
            .map((c) => c.name)
            .sort()
            .join(",");

        // Check cache first
        const cached = this.queryMaskCache[cacheKey];
        if (cached) return cached;

        // Find max component index to determine how many words we need
        let maxIndex = -1;
        const indices: number[] = [];

        for (const component of components) {
            const index = component.__worldIndex;
            if (index === undefined) return null; // Invalid mask sentinel
            indices.push(index);
            if (index > maxIndex) maxIndex = index;
        }

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
        // Get or create reusable buffer for this query mask
        let buffer = this.queryResultBuffers[maskKey];
        if (!buffer) {
            buffer = [];
            this.queryResultBuffers[maskKey] = buffer;
        }

        // Check if cache is valid (persistent query caching)
        if (this.queryCacheVersions[maskKey] === this.archetypeVersion) {
            // Cache is valid! Return cached result (FAST PATH - no iteration!)
            return buffer;
        }

        // Cache is stale - rebuild by iterating alive entities
        const aliveEntities = this.aliveEntitiesArray;
        const length = aliveEntities.length;
        const numWords = requiredMask.length;
        let writeIdx = 0;

        // Fast path for single-word masks (most common case, <32 components)
        if (numWords === 1) {
            const mask0 = requiredMask[0];
            const componentMasks0 = this.componentMasks0;
            for (let i = 0; i < length; i++) {
                const entity = aliveEntities[i]!;
                if ((componentMasks0[entity] & mask0) === mask0) {
                    buffer[writeIdx++] = entity;
                }
            }
        } else if (numWords === 2) {
            // Unrolled for 2 words (32-63 components)
            const mask0 = requiredMask[0];
            const mask1 = requiredMask[1];
            const masks0 = this.componentMasks0;
            const masks1 = this.componentMasks[1];
            for (let i = 0; i < length; i++) {
                const entity = aliveEntities[i]!;
                if (
                    (masks0[entity] & mask0) === mask0 &&
                    (masks1[entity] & mask1) === mask1
                ) {
                    buffer[writeIdx++] = entity;
                }
            }
        } else if (numWords === 3) {
            // Unrolled for 3 words (64-95 components)
            const mask0 = requiredMask[0];
            const mask1 = requiredMask[1];
            const mask2 = requiredMask[2];
            const masks0 = this.componentMasks0;
            const masks1 = this.componentMasks[1];
            const masks2 = this.componentMasks[2];
            for (let i = 0; i < length; i++) {
                const entity = aliveEntities[i]!;
                if (
                    (masks0[entity] & mask0) === mask0 &&
                    (masks1[entity] & mask1) === mask1 &&
                    (masks2[entity] & mask2) === mask2
                ) {
                    buffer[writeIdx++] = entity;
                }
            }
        } else if (numWords === 4) {
            // Unrolled for 4 words (96-127 components)
            const mask0 = requiredMask[0];
            const mask1 = requiredMask[1];
            const mask2 = requiredMask[2];
            const mask3 = requiredMask[3];
            const masks0 = this.componentMasks0;
            const masks1 = this.componentMasks[1];
            const masks2 = this.componentMasks[2];
            const masks3 = this.componentMasks[3];
            for (let i = 0; i < length; i++) {
                const entity = aliveEntities[i]!;
                if (
                    (masks0[entity] & mask0) === mask0 &&
                    (masks1[entity] & mask1) === mask1 &&
                    (masks2[entity] & mask2) === mask2 &&
                    (masks3[entity] & mask3) === mask3
                ) {
                    buffer[writeIdx++] = entity;
                }
            }
        } else {
            // General case for 5+ words (rare)
            const componentMasks = this.componentMasks;
            outer: for (let i = 0; i < length; i++) {
                const entity = aliveEntities[i]!;
                for (let w = 0; w < numWords; w++) {
                    if (
                        (componentMasks[w][entity] & requiredMask[w]) !==
                        requiredMask[w]
                    ) {
                        continue outer;
                    }
                }
                buffer[writeIdx++] = entity;
            }
        }

        // Truncate buffer to actual size (zero allocations)
        buffer.length = writeIdx;

        // Mark cache as valid for this archetype version
        this.queryCacheVersions[maskKey] = this.archetypeVersion;

        return buffer;
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

        // Invalidate query cache since entity count changed
        this.invalidateQueryCache();

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
            }
        }

        this.clearAllComponentBits(entity);

        // Push to free list
        this.freeEntityIds[this.freeEntityHead] = entity;
        this.freeEntityHead = (this.freeEntityHead + 1) & this.freeEntityMask; // Bitwise AND instead of modulo
        this.freeEntityCount++;

        // Invalidate query cache since entity count changed
        this.invalidateQueryCache();
    }

    /**
     * Check if an entity is alive
     */
    isAlive(entity: Entity): boolean {
        return this.aliveEntityFlags[entity] === 1;
    }

    /**
     * Invalidate all query caches (called on archetype changes).
     */
    private invalidateQueryCache(): void {
        this.archetypeVersion++;
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

        // Invalidate query cache since archetype changed
        this.invalidateQueryCache();
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

        // Invalidate query cache since archetype changed
        this.invalidateQueryCache();
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
     *     x: t.x + v.vx * dt,
     *     y: t.y + v.vy * dt
     *   });
     * }
     * ```
     */
    query(...components: Component<any>[]): readonly Entity[] {
        const requiredMask = this.getQueryMask(components);
        if (requiredMask === null) return []; // Component not registered

        const maskKey = this.maskToKey(requiredMask);

        // Get or create reusable buffer for this query mask
        let buffer = this.queryResultBuffers[maskKey];
        if (!buffer) {
            buffer = [];
            this.queryResultBuffers[maskKey] = buffer;
        }

        // Check if cache is valid (persistent query caching)
        if (this.queryCacheVersions[maskKey] === this.archetypeVersion) {
            // Cache is valid! Return cached result (FAST PATH - no iteration!)
            return buffer;
        }

        // Cache miss or stale - recompute query results
        const entities = this.aliveEntitiesArray;
        const length = entities.length;
        const numWords = requiredMask.length;

        // Use write cursor pattern instead of buffer.length = 0 + push
        let writeIdx = 0;

        // Inline fast path for single-word masks (avoids function call overhead)
        if (numWords === 1) {
            const mask0 = requiredMask[0];
            const masks0 = this.componentMasks0;
            for (let i = 0; i < length; i++) {
                const entity = entities[i];
                if ((masks0[entity] & mask0) === mask0) {
                    buffer[writeIdx++] = entity;
                }
            }
        } else {
            // Fall back to matchesComponentMask for multi-word
            for (let i = 0; i < length; i++) {
                const entity = entities[i];
                if (this.matchesComponentMask(entity, requiredMask)) {
                    buffer[writeIdx++] = entity;
                }
            }
        }

        // Truncate buffer to actual size
        buffer.length = writeIdx;

        // Mark cache as valid for this archetype version
        this.queryCacheVersions[maskKey] = this.archetypeVersion;

        return buffer;
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
     * Serialize entities with specific components to binary.
     * Uses PooledCodec internally for efficient encoding.
     *
     * @param components Components to include in the snapshot
     * @param entities Optional list of entities to serialize (defaults to all)
     * @returns Binary buffer with serialized data
     */
    serialize(components: Component<any>[], entities?: Entity[]): Uint8Array {
        const entityList = entities ?? Array.from(this.aliveEntitiesArray);

        // Build data structure for each component
        const componentArrays: any[] = [];

        for (const component of components) {
            const index = component.__worldIndex;
            if (index === undefined) continue;

            const store = this.componentStoresArray[index];
            if (!store) continue;

            const items: any[] = [];

            for (const entity of entityList) {
                if (this.has(entity, component)) {
                    items.push({
                        entity,
                        ...store.getMutable(entity),
                    });
                }
            }

            if (items.length > 0) {
                // Use the component's arrayCodec (PooledCodec.array) to encode
                const encoded = component.arrayCodec.encode(items);
                componentArrays.push(encoded);
            }
        }

        // Combine all buffers
        // TODO: Could optimize this with a proper multi-buffer format
        const totalSize = componentArrays.reduce(
            (sum, buf) => sum + buf.length,
            0,
        );
        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const buf of componentArrays) {
            result.set(buf, offset);
            offset += buf.length;
        }

        return result;
    }

    /**
     * Deserialize binary data into entities.
     * Uses PooledCodec internally for efficient decoding.
     *
     * Note: This is a basic implementation. For production use,
     * you'd want a more sophisticated format with component IDs, etc.
     */
    deserialize(components: Component<any>[], buffer: Uint8Array): void {
        // TODO: Implement proper deserialization with component IDs
        // For now, this is a placeholder
        throw new Error("Deserialization not yet implemented");
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
     *   transformX[entity] += velocityVx[entity] * dt;
     *   transformY[entity] += velocityVy[entity] * dt;
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

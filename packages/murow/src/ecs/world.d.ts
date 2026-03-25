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
export declare class World extends WorldSystems {
    private maxEntities;
    private nextEntityId;
    private freeEntityIds;
    private freeEntityHead;
    private freeEntityTail;
    private freeEntityCount;
    private freeEntityMask;
    private aliveEntitiesArray;
    private aliveEntitiesIndices;
    private aliveEntityFlags;
    componentStoresArray: (ComponentStore<any> | undefined)[];
    private componentMasks;
    private componentMasks0;
    private numMaskWords;
    private components;
    private queryResultBuffers;
    private archetypeVersion;
    private queryCacheVersions;
    private queryMaskCache;
    private worldId;
    constructor(config: WorldConfig);
    /**
     * Get component index (O(1) - stored directly on component)
     */
    private getComponentIndex;
    /**
     * Set a bit in the bitmask for an entity
     */
    private setComponentBit;
    /**
     * Clear a bit in the bitmask for an entity
     */
    private clearComponentBit;
    /**
     * Check if a bit is set in the bitmask for an entity
     */
    private hasComponentBit;
    /**
     * Clear all component bits for an entity
     */
    private clearAllComponentBits;
    /**
     * Check if entity matches the required component mask
     * Returns true if entity has all required components
     *
     * Optimized for common case: most games use <32 components,
     * so we only need to check the first word
     */
    private matchesComponentMask;
    /**
     * Get or compute query bitmask
     * Returns array of numbers (one 32-bit mask per word)
     *
     * Caches masks to avoid recomputation for frequently used component combinations
     */
    private getQueryMask;
    /**
     * Convert mask array to a hash key for caching
     */
    private maskToKey;
    /**
     * Internal: Get query mask key for a set of components.
     * Used by SystemBuilder for precomputing query keys.
     * @internal
     */
    private _getQueryMaskKey;
    /**
     * Internal: Query entities by precomputed mask key and mask.
     * Used by ExecutableSystem for fast queries without mask recomputation.
     * @internal
     */
    private _queryByMaskKey;
    /**
     * Spawn a new entity.
     * Returns the entity ID.
     */
    spawn(): Entity;
    /**
     * Despawn an entity, removing all its components.
     * The entity ID will be reused.
     */
    despawn(entity: Entity): void;
    /**
     * Check if an entity is alive
     */
    isAlive(entity: Entity): boolean;
    /**
     * Invalidate all query caches (called on archetype changes).
     */
    private invalidateQueryCache;
    /**
     * Add a component to an entity with initial data.
     */
    add<T extends object>(entity: Entity, component: Component<T>, data: T): void;
    /**
     * Remove a component from an entity.
     */
    remove<T extends object>(entity: Entity, component: Component<T>): void;
    /**
     * Check if an entity has a component.
     */
    has<T extends object>(entity: Entity, component: Component<T>): boolean;
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
    get<T extends object>(entity: Entity, component: Component<T>): Readonly<T>;
    /**
     * Get a mutable copy of component data.
     * Use this when you need to modify and keep the data.
     *
     * Note: This allocates a new object. Use sparingly in hot paths.
     */
    getMutable<T extends object>(entity: Entity, component: Component<T>): T;
    /**
     * Set a component's data for an entity.
     * Overwrites all fields.
     */
    set<T extends object>(entity: Entity, component: Component<T>, data: T): void;
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
    update<T extends object>(entity: Entity, component: Component<T>, partial: Partial<T>): void;
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
    query(...components: Component<any>[]): readonly Entity[];
    /**
     * Get all alive entity IDs.
     *
     * ⚠️ WARNING: The returned array is a direct reference and should not be modified.
     * For a safe copy, use [...world.getEntities()].
     */
    getEntities(): readonly Entity[];
    /**
     * Get the number of alive entities.
     */
    getEntityCount(): number;
    /**
     * Get the maximum number of entities.
     */
    getMaxEntities(): number;
    /**
     * Get all registered components.
     */
    getComponents(): readonly Component<any>[];
    /**
     * Get component names for an entity (for debugging)
     */
    private getEntityComponentNames;
    /**
     * Serialize entities with specific components to binary.
     * Uses PooledCodec internally for efficient encoding.
     *
     * @param components Components to include in the snapshot
     * @param entities Optional list of entities to serialize (defaults to all)
     * @returns Binary buffer with serialized data
     */
    serialize(components: Component<any>[], entities?: Entity[]): Uint8Array;
    /**
     * Deserialize binary data into entities.
     * Uses PooledCodec internally for efficient decoding.
     *
     * Note: This is a basic implementation. For production use,
     * you'd want a more sophisticated format with component IDs, etc.
     */
    deserialize(components: Component<any>[], buffer: Uint8Array): void;
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
    getFieldArray<T extends object>(component: Component<T>, fieldName: keyof T): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;
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
    entity(entityId: Entity): EntityHandle;
}

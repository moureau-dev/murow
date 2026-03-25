import { Component } from "./component";
import { Entity, World } from "./world";
/**
 * Syntactic sugar wrapper for entity operations.
 *
 * **Optimized for performance** - Uses raw component store access with inline caching
 * to bypass validation overhead in the public World API.
 *
 * Performance optimizations:
 * - Inline caching: Component indices cached on first access (~29% faster)
 * - Direct store access: Skips validation checks (has-component, error throwing)
 * - Zero allocations: No intermediate objects created
 *
 * @example
 * ```typescript
 * // Fluent chaining API
 * const player = world.entity(world.spawn())
 *   .add(Transform, { x: 0, y: 0, rotation: 0 })
 *   .add(Health, { current: 100, max: 100 })
 *   .add(Velocity, { vx: 0, vy: 0 });
 *
 * // Use the handle - with inline cached store access
 * player.update(Transform, { x: 10 });
 * const health = player.get(Health);
 *
 * // Access raw entity ID
 * console.log(player.id); // number
 * ```
 *
 * @example
 * ```typescript
 * // EntityHandle with inline caching is faster:
 * // World API - validates every call:
 * world.update(entity, Transform, { x: 10 });  // Map.get() + hasComponentBit + validation
 * world.update(entity, Transform, { x: 20 });  // Map.get() + hasComponentBit + validation
 *
 * // EntityHandle - cached direct access:
 * handle.update(Transform, { x: 10 });  // Map.get() + cache + store.update
 * handle.update(Transform, { x: 20 });  // Cached! store.update only
 * ```
 */
export declare class EntityHandle {
    private readonly world;
    private _id;
    private static batchArrays;
    private static batchIndices;
    private static batchValues;
    private static batchLength;
    private static preparedComponents;
    private static preparedCount;
    private isBatching;
    /**
     * Creates an entity handle wrapping a world and entity ID.
     *
     * **Note**: Prefer using `world.entity(id)` factory method for cleaner code.
     *
     * @param world - The world managing this entity
     * @param id - The entity ID
     *
     * @example
     * ```typescript
     * // Direct construction (verbose)
     * const handle = new EntityHandle(world, world.spawn());
     *
     * // Preferred factory method (cleaner)
     * const handle = world.entity(world.spawn());
     * ```
     */
    constructor(world: World, _id: Entity);
    /**
     * Internal method to reset the entity ID for handle reuse.
     * @internal
     */
    _reset(id: Entity): void;
    /**
     * Get component index with inline caching on the Component object.
     * First call does Map.get() and caches on component.__cachedIndex.
     * Subsequent calls use the cached value (~29% faster).
     *
     * @internal
     */
    private getComponentIndex;
    /**
     * Get direct TypedArray access to a specific field.
     * Cached on Component object for maximum performance.
     *
     * **Zero-cost abstraction** - Same speed as RAW API after first access.
     *
     * @param component - Component definition
     * @param field - Field name
     * @returns TypedArray with direct access to the field
     *
     * @example
     * ```typescript
     * const transformX = entity.field(Transform, 'x');
     * const velocityVx = entity.field(Velocity, 'vx');
     *
     * // Direct array access - same as RAW API!
     * transformX[entity.id] += velocityVx[entity.id] * dt;
     * ```
     */
    field<T extends object, K extends keyof T>(component: Component<T>, field: K): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;
    /**
     * Add a component to this entity with initial data.
     * Returns `this` for method chaining.
     *
     * @param component - Component definition to add
     * @param data - Initial component data
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * entity
     *   .add(Transform, { x: 0, y: 0, rotation: 0 })
     *   .add(Health, { current: 100, max: 100 });
     * ```
     */
    add<T extends object>(component: Component<T>, data: T): this;
    /**
     * Get component data for this entity.
     * Returns a readonly reusable object (zero allocations).
     *
     * In batch mode, returns cached data if available (from prepare() call).
     *
     * @param component - Component to retrieve
     * @returns Readonly component data
     *
     * @example
     * ```typescript
     * const transform = entity.get(Transform);
     * console.log(transform.x, transform.y);
     * ```
     */
    get<T extends object>(component: Component<T>): Readonly<T>;
    /**
     * Pre-fetch and cache component data for batch mode.
     * Use this before get() calls in beginUpdate() blocks for better performance.
     *
     * Only has effect in batch mode - does nothing when called outside beginUpdate().
     *
     * @param components - Components to pre-fetch
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * entity.beginUpdate().prepare(Transform, Velocity);
     *
     * const transform = entity.get(Transform);  // Uses cached data
     * const velocity = entity.get(Velocity);    // Uses cached data
     *
     * entity
     *   .setField(Transform, 'x', transform.x + velocity.vx * dt)
     *   .setField(Transform, 'y', transform.y + velocity.vy * dt)
     *   .flush();
     * ```
     */
    prepare(...components: Component<any>[]): this;
    /**
     * Update specific fields of a component.
     * Returns `this` for method chaining.
     *
     * More efficient than get + set for partial changes.
     *
     * @param component - Component to update
     * @param data - Partial data to update
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * // Update single field
     * entity.update(Transform, { x: 150 });
     *
     * // Chain multiple updates
     * entity
     *   .update(Transform, { x: 100, y: 200 })
     *   .update(Health, { current: 50 });
     * ```
     */
    update<T extends object>(component: Component<T>, data: Partial<T>): this;
    /**
     * Update fields using an updater function that mutates the component data directly.
     * Zero allocations - the function mutates the mutable data object in place.
     *
     * @param component - Component to update
     * @param updater - Function that receives mutable data and mutates it directly
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * // Mutate fields directly
     * entity.setFields(Transform, function (t) {
     *   t.x += velocity.vx * dt;
     *   t.y += velocity.vy * dt;
     * });
     *
     * // Conditional mutation
     * entity.setFields(Health, function (h) {
     *   if (h.current < h.max) {
     *     h.current += 5;
     *   }
     * });
     * ```
     */
    setFields<T extends object>(component: Component<T>, updater: (current: T) => void): this;
    /**
     * Set a single field directly without allocating an object.
     * Zero-cost operation - same speed as RAW API.
     *
     * When batching is enabled (via beginUpdate()), this queues the update
     * instead of applying it immediately. Call flush() to apply batched updates.
     *
     * @param component - Component to update
     * @param field - Field name
     * @param value - New value
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * // Immediate update
     * entity.setField(Transform, 'x', 150);
     *
     * // Batched updates (reduced allocations, better JIT)
     * entity.beginUpdate()
     *   .setField(Transform, 'x', 150)
     *   .setField(Transform, 'y', 200)
     *   .setField(Health, 'current', 50)
     *   .flush();
     * ```
     */
    setField<T extends object, K extends keyof T>(component: Component<T>, field: K, value: T[K]): this;
    /**
     * Get a single field value directly.
     * More efficient than get() when you only need one field.
     *
     * @param component - Component to read from
     * @param field - Field name
     * @returns Field value
     *
     * @example
     * ```typescript
     * const x = entity.getField(Transform, 'x');
     * const health = entity.getField(Health, 'current');
     * ```
     */
    getField<T extends object, K extends keyof T>(component: Component<T>, field: K): T[K];
    /**
     * Set component data for this entity, overwriting all fields.
     * Returns `this` for method chaining.
     *
     * @param component - Component to set
     * @param data - Complete component data
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * entity.set(Transform, { x: 100, y: 200, rotation: 0 });
     * ```
     */
    set<T extends object>(component: Component<T>, data: T): this;
    /**
     * Check if this entity has a specific component.
     *
     * @param component - Component to check
     * @returns True if entity has the component
     *
     * @example
     * ```typescript
     * if (entity.has(Health)) {
     *   const health = entity.get(Health);
     * }
     * ```
     */
    has<T extends object>(component: Component<T>): boolean;
    /**
     * Remove a component from this entity.
     * Returns `this` for method chaining.
     *
     * @param component - Component to remove
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * entity
     *   .remove(Velocity)
     *   .remove(Health);
     * ```
     */
    remove<T extends object>(component: Component<T>): this;
    /**
     * Despawn this entity, removing all components.
     * The entity ID will be reused.
     *
     * **Note**: This handle becomes invalid after despawning.
     *
     * @example
     * ```typescript
     * entity.despawn();
     * // entity is now invalid - don't use it!
     * ```
     */
    despawn(): void;
    /**
     * Check if this entity is alive.
     *
     * @returns True if entity exists in the world
     *
     * @example
     * ```typescript
     * if (entity.isAlive()) {
     *   entity.update(Health, { current: 0 });
     * }
     * ```
     */
    isAlive(): boolean;
    /**
     * Get the raw entity ID.
     *
     * Use this when you need to pass the entity to raw World API methods
     * or store the ID for later use.
     *
     * @example
     * ```typescript
     * const id = entity.id;
     * world.add(id, Transform, { x: 0, y: 0, rotation: 0 });
     * ```
     */
    get id(): Entity;
    /**
     * Get a mutable copy of component data.
     *
     * **Note**: This allocates a new object. Use sparingly in hot paths.
     *
     * @param component - Component to retrieve
     * @returns Mutable copy of component data
     *
     * @example
     * ```typescript
     * const transform = entity.getMutable(Transform);
     * transform.x = 100; // OK to mutate
     * entity.set(Transform, transform);
     * ```
     */
    getMutable<T extends object>(component: Component<T>): T;
    /**
     * Begin batching updates for better performance.
     * All setField() calls will be queued until flush() is called.
     *
     * **Benefits:**
     * - Reduced allocations (reusable batch array)
     * - Better JIT optimization (predictable pattern)
     * - Reduced GC pressure
     *
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * // Batch multiple field updates
     * entity.beginUpdate()
     *   .setField(Transform, 'x', 150)
     *   .setField(Transform, 'y', 200)
     *   .setField(Transform, 'rotation', 1.5)
     *   .flush();
     * ```
     */
    beginUpdate(): this;
    /**
     * Apply all batched updates.
     * Resets batching mode - subsequent setField() calls apply immediately.
     *
     * @returns This handle for chaining
     *
     * @example
     * ```typescript
     * entity.beginUpdate()
     *   .setField(Transform, 'x', 150)
     *   .setField(Health, 'current', 50)
     *   .flush(); // Applies both updates
     * ```
     */
    flush(): this;
}

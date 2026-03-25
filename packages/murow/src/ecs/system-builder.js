/**
 * Builder for creating ergonomic systems with automatic field array caching.
 *
 * Fully chainable API with type safety:
 * - System automatically caches TypedArrays and creates proxies
 * - Two access patterns: ergonomic (getter/setter) or hybrid (direct array)
 * - Full type safety with IntelliSense support for both patterns
 *
 * **Ergonomic pattern (convenient but slower):**
 * ```typescript
 * world.addSystem()
 *   .query(Transform2D, Velocity)
 *   .fields([{ transform: ['x', 'y'] }, { velocity: ['vx', 'vy'] }])
 *   .run((entity, deltaTime) => {
 *     // Fully typed property access (uses getters/setters)
 *     entity.transform_x += entity.velocity_vx * deltaTime;
 *   });
 * ```
 *
 * **Hybrid pattern (fast and still ergonomic):**
 * ```typescript
 * world.addSystem()
 *   .query(Transform2D, Velocity)
 *   .fields([{ transform: ['x', 'y'] }, { velocity: ['vx', 'vy'] }])
 *   .run((entity, deltaTime) => {
 *     // Fully typed direct array access (no getters/setters)
 *     const {eid, transform_x_array: tx, velocity_vx_array: vx} = entity;
 *     tx[eid] += vx[eid] * deltaTime;
 *   });
 * ```
 *
 * **Note:** The hybrid pattern is recommended for performance-critical systems.
 * Both patterns provide full TypeScript autocomplete and type checking.
 */
export class SystemBuilder {
    constructor(world, components, fieldMappings, userCallback, conditionPredicate) {
        this.world = world;
        this.components = components;
        this.fieldMappings = fieldMappings;
        this.userCallback = userCallback;
        this.conditionPredicate = conditionPredicate;
    }
    /**
     * Specify which components this system should query for.
     */
    query(...components) {
        return new SystemBuilder(this.world, components, this.fieldMappings, this.userCallback, this.conditionPredicate);
    }
    /**
     * Specify which component fields should be accessible via proxy.
     */
    fields(fieldMappings) {
        return new SystemBuilder(this.world, this.components, fieldMappings, this.userCallback, this.conditionPredicate);
    }
    /**
     * Specify a condition to filter entities before running the system callback.
     * @param predicate - Condition to filter entities before running the system callback.
     * @returns A new SystemBuilder instance with the specified condition.
     */
    when(predicate) {
        if (!this.fieldMappings) {
            throw new Error('Must call .fields() before .when()');
        }
        // Extract all field arrays once (or reuse cached)
        const fieldArrays = {};
        for (let i = 0; i < this.components.length; i++) {
            const component = this.components[i];
            const mapping = this.fieldMappings[i];
            if (!mapping)
                continue;
            const alias = Object.keys(mapping)[0];
            const fields = mapping[alias];
            for (const fieldName of fields) {
                const flattenedName = `${alias}_${fieldName}`;
                const array = this.world.getFieldArray(component, fieldName);
                fieldArrays[flattenedName] = array;
            }
        }
        // Create reusable proxy (ZERO allocations per entity!)
        const proxyEntity = { eid: 0 };
        // Define getters + expose arrays (for...in instead of Object.entries)
        for (const name in fieldArrays) {
            const array = fieldArrays[name];
            // Ergonomic getter/setter access
            Object.defineProperty(proxyEntity, name, {
                get() { return array[this.eid]; },
                set(value) { array[this.eid] = value; },
                enumerable: true,
                configurable: false
            });
            // Hybrid direct array access
            proxyEntity[`${name}_array`] = array;
        }
        // Seal proxy to lock shape (allows eid updates, prevents additions/deletions)
        Object.seal(proxyEntity);
        // Fast predicate: reuses proxy, updates eid (clean signature)
        const userPredicate = predicate; // Inline reference
        return new SystemBuilder(this.world, this.components, this.fieldMappings, this.userCallback, userPredicate);
    }
    /**
     * Set the system callback. If components and fields are set, builds the system.
     */
    run(callback) {
        const builder = new SystemBuilder(this.world, this.components, this.fieldMappings, callback, this.conditionPredicate);
        return builder.buildAndRegister();
    }
    /**
     * Build and register the system.
     * @internal
     */
    buildAndRegister() {
        if (!this.userCallback) {
            throw new Error('System callback must be set');
        }
        if (!this.fieldMappings) {
            throw new Error('Field mappings must be set');
        }
        const world = this.world;
        const components = this.components;
        const fieldMappings = this.fieldMappings;
        const userCallback = this.userCallback;
        // Cache field arrays once at system creation
        const fieldArrayCache = {};
        const componentByAlias = {};
        const aliases = [];
        // Iterate over components and their field mappings
        for (let i = 0; i < components.length; i++) {
            const component = components[i];
            const mapping = fieldMappings[i];
            if (!mapping)
                continue;
            // Extract alias and fields from { alias: ['fields'] } object
            const alias = Object.keys(mapping)[0];
            const fields = mapping[alias];
            aliases.push(alias);
            componentByAlias[alias] = component;
            fieldArrayCache[alias] = {};
            // Cache all field arrays for this component
            for (const fieldName of fields) {
                const array = world.getFieldArray(component, fieldName);
                fieldArrayCache[alias][fieldName] = array;
            }
        }
        // Precompute flat field descriptor list (specialization contract)
        const fieldDescs = [];
        for (const alias of aliases) {
            const fields = fieldArrayCache[alias];
            for (const fieldName in fields) {
                fieldDescs.push({
                    prop: `${alias}_${fieldName}`,
                    array: fields[fieldName],
                });
            }
        }
        // Precompute query mask and mask key for fast queries
        // This avoids rebuilding the cache key string every frame
        world.query(...components); // Initializes the cache
        const queryMaskKey = world._getQueryMaskKey(components);
        const queryMask = world.getQueryMask(components);
        // Create the executable system with specialized field descriptors
        const system = new ExecutableSystem(world, components, userCallback, fieldDescs, queryMaskKey, queryMask, this.conditionPredicate);
        // Register with world
        world._registerSystem(system);
        return system;
    }
}
/**
 * Executable system that can be run with world.runSystems().
 *
 * Uses reusable proxy entity with optimized getter/setter access.
 */
export class ExecutableSystem {
    constructor(world, components, userCallback, fieldDescs, queryMaskKey, queryMask, conditionPredicate) {
        this.world = world;
        this.components = components;
        this.userCallback = userCallback;
        this.fieldDescs = fieldDescs;
        this.queryMaskKey = queryMaskKey;
        this.queryMask = queryMask;
        this.conditionPredicate = conditionPredicate;
        // Create proxy entity once and reuse
        this.proxyEntity = this.createProxyEntity();
    }
    /**
     * Execute the system for all matching entities.
     *
     * @param deltaTime - Time delta to pass to system callback
     */
    execute(deltaTime) {
        const entities = this.world._queryByMaskKey(this.queryMaskKey, this.queryMask);
        const callback = this.userCallback;
        const world = this.world;
        const entity = this.proxyEntity;
        const length = entities.length;
        // Fast path: no predicate
        if (!this.conditionPredicate) {
            for (let i = 0; i < length; i++) {
                entity.eid = entities[i];
                callback(entity, deltaTime, world);
            }
        }
        else {
            // Filtered path: with predicate
            const predicate = this.conditionPredicate;
            for (let i = 0; i < length; i++) {
                entity.eid = entities[i];
                if (predicate(entity)) {
                    callback(entity, deltaTime, world);
                }
            }
        }
    }
    /**
     * Create proxy entity that exposes arrays directly.
     *
     * Each getter closes over a specific TypedArray.
     */
    createProxyEntity() {
        const world = this.world;
        const entity = {
            eid: 0,
            despawn() {
                world.despawn(this.eid);
            },
        };
        // static property list, static closures
        for (let i = 0; i < this.fieldDescs.length; i++) {
            const { prop, array } = this.fieldDescs[i];
            // Hybrid direct array access
            entity[`${prop}_array`] = array;
            // Ergonomic getter/setter access
            Object.defineProperty(entity, prop, {
                get() { return array[this.eid]; },
                set(value) { array[this.eid] = value; },
                enumerable: true,
                configurable: false,
            });
        }
        Object.seal(entity);
        Object.preventExtensions(entity);
        return entity;
    }
    /**
     * Get the components this system operates on.
     */
    getComponents() {
        return this.components;
    }
}

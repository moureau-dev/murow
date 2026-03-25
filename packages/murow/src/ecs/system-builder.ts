import { Component } from "./component";
import { Entity, World } from "./world";

/**
 * Extract component data type from Component<T>
 */
type InferComponentData<C> = C extends Component<infer T> ? T : never;

/**
 * Field descriptor for specialized proxy creation.
 */
type FieldDesc = {
  prop: string;
  array: any;
};

/**
 * Extract the alias (key) and fields from a field mapping object.
 * { transform2d: ['x', 'y'] } => { alias: 'transform2d', fields: ['x', 'y'] }
 */
type ExtractFieldMapping<T> = T extends Record<string, readonly any[]>
  ? {
    [K in keyof T]: {
      alias: K;
      fields: T[K];
    }
  }[keyof T]
  : never;

/**
 * Build entity proxy from components and field mappings with FLATTENED property names.
 * Properties are named as alias_field (e.g., entity.transform_x instead of entity.transform.x).
 * This eliminates one property lookup for better performance (~10% faster than nested).
 * All properties are mutable for writes.
 *
 * Also includes _array properties for direct TypedArray access:
 * - entity.transform_x (getter/setter - ergonomic but slower)
 * - entity.transform_x_array (TypedArray - hybrid mode, faster)
 */
export type BuildEntityProxy<
  Components extends readonly Component<any>[],
  FieldMappings extends readonly any[]
> = {
  eid: number;
  despawn: () => void;
} & {
    // Getter/setter properties (ergonomic API)
    -readonly [Index in keyof FieldMappings as Index extends keyof Components
    ? Components[Index] extends Component<any>
    ? ExtractFieldMapping<FieldMappings[Index]>["fields"] extends readonly (keyof InferComponentData<Components[Index]>)[]
    ? ExtractFieldMapping<FieldMappings[Index]>["fields"][number] extends keyof InferComponentData<Components[Index]>
    ? `${ExtractFieldMapping<FieldMappings[Index]>["alias"] & string}_${ExtractFieldMapping<FieldMappings[Index]>["fields"][number] & string}`
    : never
    : never
    : never
    : never]: Index extends keyof Components
    ? Components[Index] extends Component<any>
    ? ExtractFieldMapping<FieldMappings[Index]>["fields"] extends readonly (keyof InferComponentData<Components[Index]>)[]
    ? ExtractFieldMapping<FieldMappings[Index]>["fields"][number] extends keyof InferComponentData<Components[Index]>
    ? InferComponentData<Components[Index]>[ExtractFieldMapping<FieldMappings[Index]>["fields"][number]]
    : never
    : never
    : never
    : never;
  } & {
    // Direct array properties (hybrid API)
    -readonly [Index in keyof FieldMappings as Index extends keyof Components
    ? Components[Index] extends Component<any>
    ? ExtractFieldMapping<FieldMappings[Index]>["fields"] extends readonly (keyof InferComponentData<Components[Index]>)[]
    ? ExtractFieldMapping<FieldMappings[Index]>["fields"][number] extends keyof InferComponentData<Components[Index]>
    ? `${ExtractFieldMapping<FieldMappings[Index]>["alias"] & string}_${ExtractFieldMapping<FieldMappings[Index]>["fields"][number] & string}_array`
    : never
    : never
    : never
    : never]: Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;
  };

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
export class SystemBuilder<
  C extends Component<any>[] = Component<any>[],
  FM extends any[] | undefined = undefined,
  CB extends boolean = false
> {
  constructor(
    private world: World,
    private components: C,
    private fieldMappings?: FM,
    private userCallback?: (entity: any, deltaTime: number, world: World) => void,
    private conditionPredicate?: CB extends true
      ? (entity: BuildEntityProxy<C, FM>) => boolean
      : undefined
  ) { }

  /**
   * Specify which components this system should query for.
   */
  query<NewC extends Component<any>[]>(
    ...components: NewC
  ): SystemBuilder<NewC, FM, CB> {
    return new SystemBuilder(this.world, components, this.fieldMappings, this.userCallback, this.conditionPredicate as any);
  }

  /**
   * Specify which component fields should be accessible via proxy.
   */
  fields<
    const NewFM extends {
      [K in keyof C]: C[K] extends Component<infer T>
      ? Record<string, readonly (keyof T)[]>
      : never
    }
  >(
    fieldMappings: NewFM
  ): SystemBuilder<C, NewFM, CB> {
    return new SystemBuilder(this.world, this.components, fieldMappings as any, this.userCallback, this.conditionPredicate as any);
  }

  /**
   * Specify a condition to filter entities before running the system callback.
   * @param predicate - Condition to filter entities before running the system callback.
   * @returns A new SystemBuilder instance with the specified condition.
   */
  when(predicate: (entity: BuildEntityProxy<C, FM>) => boolean): SystemBuilder<C, FM, true> {
    if (!this.fieldMappings) {
      throw new Error('Must call .fields() before .when()');
    }

    // Extract all field arrays once (or reuse cached)
    const fieldArrays: Record<string, any> = {};

    for (let i = 0; i < this.components.length; i++) {
      const component = this.components[i]!;
      const mapping = this.fieldMappings[i];
      if (!mapping) continue;

      const alias = Object.keys(mapping)[0]!;
      const fields = mapping[alias];

      for (const fieldName of fields) {
        const flattenedName = `${alias}_${fieldName}`;
        const array = this.world.getFieldArray(component, fieldName);
        fieldArrays[flattenedName] = array;
      }
    }

    // Create reusable proxy (ZERO allocations per entity!)
    const proxyEntity: any = { eid: 0 };

    // Define getters + expose arrays (for...in instead of Object.entries)
    for (const name in fieldArrays) {
      const array = fieldArrays[name];

      // Ergonomic getter/setter access
      Object.defineProperty(proxyEntity, name, {
        get() { return array[this.eid]; },
        set(value: any) { array[this.eid] = value; },
        enumerable: true,
        configurable: false
      });

      // Hybrid direct array access
      proxyEntity[`${name}_array`] = array;
    }

    // Seal proxy to lock shape (allows eid updates, prevents additions/deletions)
    Object.seal(proxyEntity);

    // Fast predicate: reuses proxy, updates eid (clean signature)
    const userPredicate = predicate;  // Inline reference

    return new SystemBuilder(this.world, this.components, this.fieldMappings, this.userCallback, userPredicate);
  }

  /**
   * Set the system callback. If components and fields are set, builds the system.
   */
  run(
    callback: FM extends undefined
      ? (entity: any, deltaTime: number, world: World) => void
      : (entity: BuildEntityProxy<C, FM>, deltaTime: number, world: World) => void
  ): ExecutableSystem {
    const builder = new SystemBuilder(
      this.world,
      this.components,
      this.fieldMappings,
      callback as any,
      this.conditionPredicate,
    );

    return builder.buildAndRegister();
  }

  /**
   * Build and register the system.
   * @internal
   */
  buildAndRegister(): ExecutableSystem {
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
    const fieldArrayCache: Record<string, Record<string, any>> = {};
    const componentByAlias: Record<string, Component<any>> = {};
    const aliases: string[] = [];

    // Iterate over components and their field mappings
    for (let i = 0; i < components.length; i++) {
      const component = components[i]!;
      const mapping = fieldMappings[i];

      if (!mapping) continue;

      // Extract alias and fields from { alias: ['fields'] } object
      const alias = Object.keys(mapping)[0]!;
      const fields = mapping[alias];

      aliases.push(alias);
      componentByAlias[alias] = component;
      fieldArrayCache[alias] = {};

      // Cache all field arrays for this component
      for (const fieldName of fields) {
        const array = (world as any).getFieldArray(component, fieldName);
        fieldArrayCache[alias][fieldName as string] = array;
      }
    }

    // Precompute flat field descriptor list (specialization contract)
    const fieldDescs: FieldDesc[] = [];
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
    const queryMaskKey = (world as any)._getQueryMaskKey(components);
    const queryMask = (world as any).getQueryMask(components);

    // Create the executable system with specialized field descriptors
    const system = new ExecutableSystem(
      world,
      components,
      userCallback,
      fieldDescs,
      queryMaskKey,
      queryMask,
      this.conditionPredicate,
    );

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
  // Reusable proxy entity
  private proxyEntity: any;

  constructor(
    private world: World,
    private components: Component<any>[],
    private userCallback: (entity: any, deltaTime: number, world: World) => void,
    private fieldDescs: FieldDesc[],
    private queryMaskKey: string,
    private queryMask: number[],
    private conditionPredicate?: (entity: any) => boolean,
  ) {
    // Create proxy entity once and reuse
    this.proxyEntity = this.createProxyEntity();
  }

  /**
   * Execute the system for all matching entities.
   *
   * @param deltaTime - Time delta to pass to system callback
   */
  execute(deltaTime: number): void {
    const entities = (this.world as any)._queryByMaskKey(this.queryMaskKey, this.queryMask);
    const callback = this.userCallback;
    const world = this.world;
    const entity = this.proxyEntity;
    const length = entities.length;

    // Fast path: no predicate
    if (!this.conditionPredicate) {
      for (let i = 0; i < length; i++) {
        entity.eid = entities[i]!;

        callback(entity, deltaTime, world);
      }
    } else {
      // Filtered path: with predicate
      const predicate = this.conditionPredicate;
      for (let i = 0; i < length; i++) {
        entity.eid = entities[i]!;

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
  private createProxyEntity(): any {
    const world = this.world;

    const entity = {
      eid: 0,
      despawn() {
        world.despawn(this.eid);
      },
    };

    // static property list, static closures
    for (let i = 0; i < this.fieldDescs.length; i++) {
      const { prop, array } = this.fieldDescs[i]!;

      // Hybrid direct array access
      entity[`${prop}_array`] = array;

      // Ergonomic getter/setter access
      Object.defineProperty(entity, prop, {
        get() { return array[this.eid]; },
        set(value: any) { array[this.eid] = value; },
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
  getComponents(): Component<any>[] {
    return this.components;
  }
}

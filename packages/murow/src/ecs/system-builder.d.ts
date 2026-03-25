import { Component } from "./component";
import { World } from "./world";
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
type ExtractFieldMapping<T> = T extends Record<string, readonly any[]> ? {
    [K in keyof T]: {
        alias: K;
        fields: T[K];
    };
}[keyof T] : never;
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
export type BuildEntityProxy<Components extends readonly Component<any>[], FieldMappings extends readonly any[]> = {
    eid: number;
    despawn: () => void;
} & {
    -readonly [Index in keyof FieldMappings as Index extends keyof Components ? Components[Index] extends Component<any> ? ExtractFieldMapping<FieldMappings[Index]>["fields"] extends readonly (keyof InferComponentData<Components[Index]>)[] ? ExtractFieldMapping<FieldMappings[Index]>["fields"][number] extends keyof InferComponentData<Components[Index]> ? `${ExtractFieldMapping<FieldMappings[Index]>["alias"] & string}_${ExtractFieldMapping<FieldMappings[Index]>["fields"][number] & string}` : never : never : never : never]: Index extends keyof Components ? Components[Index] extends Component<any> ? ExtractFieldMapping<FieldMappings[Index]>["fields"] extends readonly (keyof InferComponentData<Components[Index]>)[] ? ExtractFieldMapping<FieldMappings[Index]>["fields"][number] extends keyof InferComponentData<Components[Index]> ? InferComponentData<Components[Index]>[ExtractFieldMapping<FieldMappings[Index]>["fields"][number]] : never : never : never : never;
} & {
    -readonly [Index in keyof FieldMappings as Index extends keyof Components ? Components[Index] extends Component<any> ? ExtractFieldMapping<FieldMappings[Index]>["fields"] extends readonly (keyof InferComponentData<Components[Index]>)[] ? ExtractFieldMapping<FieldMappings[Index]>["fields"][number] extends keyof InferComponentData<Components[Index]> ? `${ExtractFieldMapping<FieldMappings[Index]>["alias"] & string}_${ExtractFieldMapping<FieldMappings[Index]>["fields"][number] & string}_array` : never : never : never : never]: Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;
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
export declare class SystemBuilder<C extends Component<any>[] = Component<any>[], FM extends any[] | undefined = undefined, CB extends boolean = false> {
    private world;
    private components;
    private fieldMappings?;
    private userCallback?;
    private conditionPredicate?;
    constructor(world: World, components: C, fieldMappings?: FM, userCallback?: (entity: any, deltaTime: number, world: World) => void, conditionPredicate?: CB extends true ? (entity: BuildEntityProxy<C, FM>) => boolean : undefined);
    /**
     * Specify which components this system should query for.
     */
    query<NewC extends Component<any>[]>(...components: NewC): SystemBuilder<NewC, FM, CB>;
    /**
     * Specify which component fields should be accessible via proxy.
     */
    fields<const NewFM extends {
        [K in keyof C]: C[K] extends Component<infer T> ? Record<string, readonly (keyof T)[]> : never;
    }>(fieldMappings: NewFM): SystemBuilder<C, NewFM, CB>;
    /**
     * Specify a condition to filter entities before running the system callback.
     * @param predicate - Condition to filter entities before running the system callback.
     * @returns A new SystemBuilder instance with the specified condition.
     */
    when(predicate: (entity: BuildEntityProxy<C, FM>) => boolean): SystemBuilder<C, FM, true>;
    /**
     * Set the system callback. If components and fields are set, builds the system.
     */
    run(callback: FM extends undefined ? (entity: any, deltaTime: number, world: World) => void : (entity: BuildEntityProxy<C, FM>, deltaTime: number, world: World) => void): ExecutableSystem;
    /**
     * Build and register the system.
     * @internal
     */
    buildAndRegister(): ExecutableSystem;
}
/**
 * Executable system that can be run with world.runSystems().
 *
 * Uses reusable proxy entity with optimized getter/setter access.
 */
export declare class ExecutableSystem {
    private world;
    private components;
    private userCallback;
    private fieldDescs;
    private queryMaskKey;
    private queryMask;
    private conditionPredicate?;
    private proxyEntity;
    constructor(world: World, components: Component<any>[], userCallback: (entity: any, deltaTime: number, world: World) => void, fieldDescs: FieldDesc[], queryMaskKey: string, queryMask: number[], conditionPredicate?: (entity: any) => boolean);
    /**
     * Execute the system for all matching entities.
     *
     * @param deltaTime - Time delta to pass to system callback
     */
    execute(deltaTime: number): void;
    /**
     * Create proxy entity that exposes arrays directly.
     *
     * Each getter closes over a specific TypedArray.
     */
    private createProxyEntity;
    /**
     * Get the components this system operates on.
     */
    getComponents(): Component<any>[];
}
export {};

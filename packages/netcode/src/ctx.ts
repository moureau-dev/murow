import type { Component, Entity, World } from 'murow/ecs';
import type { SimpleRNG } from 'murow/core/simple-rng';

/**
 * Per-component typed-array bundle returned by `ctx.fields(C)`. Maps every
 * field name in the component's schema to its underlying typed array.
 */
export type ComponentFields<T extends object> = Readonly<
    Record<
        keyof T & string,
        Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array
    >
>;

export interface PredictionContext {
    world: World;
    entity: Entity;
    tick: number;
    /** Seconds since last tick. */
    deltaTime: number;
    /** Deterministic per-tick RNG. Don't use Math.random in predictions. */
    rng: SimpleRNG;
    /**
     * Get raw typed-array access to a component's fields for `ctx.entity`.
     *
     * Same shared bundle as `world.fields(C)`, plus automatic dirty tracking
     * for networked components: calling `ctx.fields(C)` marks `ctx.entity`
     * dirty for `C`, so the next snapshot picks up the write. Zero garbage,
     * RAW-speed reads/writes.
     *
     * @example
     * ```ts
     * move: ({ dx, dz }, ctx) => {
     *   const pos = ctx.fields(Position);
     *   pos.x[ctx.entity] += dx * MOVE_SPEED * ctx.deltaTime;
     *   pos.z[ctx.entity] += dz * MOVE_SPEED * ctx.deltaTime;
     * }
     * ```
     */
    fields<T extends object>(component: Component<T>): ComponentFields<T>;
    /**
     * Explicitly mark an entity dirty for one or more networked components.
     *
     * Use this when you reach into `ctx.world.fields(C)` directly (bypassing
     * `ctx.fields`'s auto-mark) and want to control exactly when the dirty
     * bit gets set - typically to skip the cost on no-op paths, to batch
     * dirty marks across multiple components after a multi-field write, or
     * to mark a target entity other than `ctx.entity` (e.g. a damage handler
     * that mutates the victim's Health bundle).
     *
     * Silently no-ops for components without `sync` metadata, and for
     * components that were never registered with the world. Defaults to
     * `ctx.entity` if no entity argument is supplied.
     *
     * @example
     * ```ts
     * // Single component, default entity.
     * ctx.markDirty(Position);
     *
     * // Multiple components, default entity (one call instead of two).
     * ctx.markDirty([Position, Health]);
     *
     * // Single component on a different entity.
     * ctx.markDirty(Health, targetId);
     *
     * // Multiple components on a different entity.
     * ctx.markDirty([Position, Health], targetId);
     *
     * // Conditional write - only pay the dirty-mark cost when something changed.
     * const pos = ctx.world.fields(Position);
     * if (Math.abs(pos.x[ctx.entity] - targetX) > EPSILON) {
     *   pos.x[ctx.entity] = targetX;
     *   ctx.markDirty(Position);
     * }
     * ```
     */
    markDirty(component: Component<any>, entity?: Entity): void;
    markDirty(components: ReadonlyArray<Component<any>>, entity?: Entity): void;
}

export interface Peer {
    peerId: string;
    /** -1 until `server.assignEntity` is called. */
    entity: Entity | -1;
}

/**
 * Build the `fields` accessor for a prediction or handler context.
 *
 * Returns a closure that, when called with a component, marks the entity
 * dirty (for synced components) and returns the world's pre-built field
 * bundle. Bundle objects are stable for the world's lifetime, so this
 * adds zero allocations on the hot path beyond the closure itself.
 */
export function makeFieldsAccessor(world: World, entity: Entity) {
    return function fields<T extends object>(component: Component<T>): ComponentFields<T> {
        if (component.__sync !== undefined && component.__worldIndex !== undefined) {
            world.markDirty(entity, component.__worldIndex);
        }
        return world.fields(component) as ComponentFields<T>;
    };
}

/**
 * Build the `markDirty` accessor for a prediction or handler context.
 *
 * Returns a closure that marks one or more (component, entity) pairs dirty
 * for the snapshot pipeline. Accepts either a single component or an array;
 * defaults to `ctxEntity` when no entity arg is passed. No-ops per component
 * for unsynced or unregistered components.
 */
export function makeMarkDirty(world: World, ctxEntity: Entity) {
    function markDirty(component: Component<any>, entity?: Entity): void;
    function markDirty(components: ReadonlyArray<Component<any>>, entity?: Entity): void;
    function markDirty(
        arg: Component<any> | ReadonlyArray<Component<any>>,
        entity?: Entity,
    ): void {
        const target = entity ?? ctxEntity;
        if (Array.isArray(arg)) {
            for (let i = 0; i < arg.length; i++) {
                const c = arg[i];
                if (c.__sync === undefined || c.__worldIndex === undefined) continue;
                world.markDirty(target, c.__worldIndex);
            }
        } else {
            const c = arg as Component<any>;
            if (c.__sync === undefined || c.__worldIndex === undefined) return;
            world.markDirty(target, c.__worldIndex);
        }
    }
    return markDirty;
}

export interface ServerHandlerContext extends PredictionContext {
    peer: Peer;
    /** Tick the client claimed they were on when they sent the intent. */
    clientTick: number;
    /** Rewind world state to `clientTick` for the duration of `fn`. */
    lagCompensated<T>(fn: () => T): T;
}

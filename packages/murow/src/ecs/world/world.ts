import type { ArrayFromField, Schema } from "../../core/binary-codec";
import { generateId } from "../../core/generate-id";
import { Component } from "../components/component";
import { ComponentStore } from "../components/component-store";
import { EntityHandle } from "../entity/entity-handle";
import { WorldSystems } from "./systems";
import { serializeEntity, restoreEntity, entityByteSize } from "./codec";
import { EntityManager, type Entity } from "../entity/entity-manager";
import { ComponentManager } from "../components/component-manager";
import { QueryManager } from "../query/query-manager";
import { DespawnTracker } from "../trackers/despawn-tracker";
import { DirtyTracker } from "../trackers/dirty-tracker";

export type { Entity } from "../entity/entity-manager";

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
 * World manages entities and their components, providing efficient ECS storage
 * using typed arrays.
 *
 * It is a thin facade: entity lifecycle, component storage, query caches, and
 * the despawn/dirty trackers each live in a dedicated manager. World owns the
 * managers and orchestrates the operations that span them (add, remove,
 * despawn, component registration).
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
 *
 * for (const entity of world.query(Transform, Velocity)) {
 *   const t = world.get(entity, Transform);
 *   const v = world.get(entity, Velocity);
 *   world.update(entity, Transform, { x: t.x + v.vx, y: t.y + v.vy });
 * }
 * ```
 */
export class World extends WorldSystems {
    private readonly entityManager: EntityManager;
    private readonly componentManager: ComponentManager;
    private readonly queryManager: QueryManager;
    private readonly despawnTracker: DespawnTracker;
    private readonly dirtyTracker: DirtyTracker;

    private worldId = generateId({ prefix: "world_" });

    constructor(config: WorldConfig) {
        super();
        const maxEntities = config.maxEntities ?? 10000;

        this.entityManager = new EntityManager(maxEntities);
        this.componentManager = new ComponentManager(maxEntities, this.worldId);
        this.dirtyTracker = new DirtyTracker(maxEntities);
        this.despawnTracker = new DespawnTracker(maxEntities);
        this.queryManager = new QueryManager(this.componentManager, this.entityManager);

        for (const component of config.components) {
            const index = this.componentManager.register(component);
            this.dirtyTracker.register(index, component.__sync !== undefined);
        }
    }

    /**
     * Register a component type with the world after construction. Idempotent
     * for a component already registered here. Returns the component so calls
     * can chain, e.g. `world.fields(world.addComponent(C))`.
     */
    addComponent<T extends object, S extends Schema<T>>(
        component: Component<T, S>,
    ): Component<T, S> {
        const components = this.componentManager.getComponents();
        const existing = component.__worldIndex;
        if (existing !== undefined && components[existing] === component) {
            return component;
        }

        const index = this.componentManager.register(component);
        this.dirtyTracker.register(index, component.__sync !== undefined);
        return component;
    }

    /**
     * Spawn a new entity. Returns the entity ID.
     */
    spawn(): Entity {
        return this.entityManager.spawn();
    }

    /**
     * Despawn an entity, removing all its components. The entity ID is reused.
     */
    despawn(entity: Entity): void {
        if (!this.entityManager.despawn(entity)) return; // already despawned
        this.despawnTracker.record(entity);
        this.componentManager.clearEntity(entity);
        this.queryManager.onEntityDespawned(entity);
    }

    /**
     * Check if an entity is alive
     */
    isAlive(entity: Entity): boolean {
        return this.entityManager.isAlive(entity);
    }

    /**
     * Add a component to an entity with initial data.
     */
    add<T extends object>(entity: Entity, component: Component<T>, data: T): void {
        if (!this.entityManager.isAlive(entity)) {
            throw new Error(
                `Cannot add component ${component.name} to entity ${entity}: ` +
                    `entity is not alive (was it despawned?). ` +
                    `Current alive entities: ${this.entityManager.count}`,
            );
        }

        const index = this.componentManager.add(entity, component, data);
        this.dirtyTracker.markDirty(entity, index);
        this.queryManager.onComponentAdded(entity);
    }

    /**
     * Remove a component from an entity.
     */
    remove<T extends object>(entity: Entity, component: Component<T>): void {
        const index = this.componentManager.remove(entity, component);
        if (index < 0) return;
        this.queryManager.onComponentRemoved(entity);
    }

    /**
     * Check if an entity has a component.
     */
    has<T extends object>(entity: Entity, component: Component<T>): boolean {
        const index = component.__worldIndex;
        if (index === undefined) return false;
        return this.componentManager.hasComponentBit(entity, index);
    }

    /**
     * Get a component's data for an entity.
     *
     * Returns a READONLY reusable object (zero allocations). The returned object
     * is reused and overwritten on the next get(): use it immediately, or copy
     * it (spread / getMutable) if you need to keep it. Use set() or update() to
     * modify.
     */
    get<T extends object>(entity: Entity, component: Component<T>): Readonly<T> {
        const index = this.componentManager.getComponentIndex(component);

        if (!this.componentManager.hasComponentBit(entity, index)) {
            const entityComponents = this.componentManager.getEntityComponentNames(entity);
            throw new Error(
                `Cannot get component ${component.name} from entity ${entity}: ` +
                    `entity does not have this component. ` +
                    `Entity has: [${entityComponents.join(", ")}]. ` +
                    `Did you forget to call world.add()?`,
            );
        }

        return this.componentManager.getStore(index).get(entity);
    }

    /**
     * Get a mutable copy of component data. Allocates a new object: use sparingly
     * in hot paths.
     */
    getMutable<T extends object>(entity: Entity, component: Component<T>): T {
        const index = this.componentManager.getComponentIndex(component);

        if (!this.componentManager.hasComponentBit(entity, index)) {
            throw new Error(
                `Entity ${entity} does not have component ${component.name}`,
            );
        }

        return this.componentManager.getStore(index).getMutable(entity);
    }

    /**
     * Set a component's data for an entity. Overwrites all fields.
     */
    set<T extends object>(entity: Entity, component: Component<T>, data: T): void {
        const index = this.componentManager.getComponentIndex(component);

        if (!this.componentManager.hasComponentBit(entity, index)) {
            throw new Error(
                `Cannot set component ${component.name} on entity ${entity}: ` +
                    `entity does not have this component. Use add() first.`,
            );
        }

        this.componentManager.getStore(index).set(entity, data);
        this.dirtyTracker.markDirty(entity, index);
    }

    /**
     * Update specific fields of a component. More efficient than get + modify + set.
     */
    update<T extends object>(
        entity: Entity,
        component: Component<T>,
        partial: Partial<T>,
    ): void {
        const index = this.componentManager.getComponentIndex(component);

        if (!this.componentManager.hasComponentBit(entity, index)) {
            throw new Error(
                `Entity ${entity} does not have component ${component.name}`,
            );
        }

        this.componentManager.getStore(index).update(entity, partial);
        this.dirtyTracker.markDirty(entity, index);
    }

    /**
     * Query entities that have all specified components. Returns a readonly array
     * for zero-allocation iteration, reused on subsequent queries with the same
     * mask.
     */
    query(...components: Component<any>[]): readonly Entity[] {
        return this.queryManager.query(components);
    }

    /**
     * Get all alive entity IDs.
     *
     * WARNING: The returned view is backed by internal storage and must not be
     * modified. For a safe copy, use [...world.getEntities()].
     */
    getEntities(): Uint32Array {
        return this.entityManager.getEntities();
    }

    /**
     * Get the number of alive entities.
     */
    getEntityCount(): number {
        return this.entityManager.count;
    }

    /**
     * Get the maximum number of entities.
     */
    getMaxEntities(): number {
        return this.entityManager.getMaxEntities();
    }

    /**
     * Get all registered components.
     */
    getComponents(): readonly Component<any>[] {
        return this.componentManager.getComponents();
    }

    /**
     * Mark an entity dirty for a given component index. No-op for components
     * without `__sync` metadata. Called by every write path.
     */
    markDirty(entity: Entity, componentIndex: number): void {
        this.dirtyTracker.markDirty(entity, componentIndex);
    }

    /**
     * Test whether an entity is currently marked dirty for a component.
     */
    isDirty(entity: Entity, component: Component<any>): boolean {
        const index = component.__worldIndex;
        if (index === undefined) return false;
        return this.dirtyTracker.isDirty(entity, index);
    }

    /**
     * Clear the dirty bit for an entity/component pair.
     */
    clearDirty(entity: Entity, component: Component<any>): void {
        const index = component.__worldIndex;
        if (index === undefined) return;
        this.dirtyTracker.clearDirty(entity, index);
    }

    /**
     * Iterate dirty entities for a synced component. No-op for unsynced ones.
     */
    forEachDirty(component: Component<any>, cb: (entity: Entity) => void): void {
        const index = component.__worldIndex;
        if (index === undefined) return;
        this.dirtyTracker.forEachDirty(index, cb);
    }

    /**
     * Clear all dirty bits across all components.
     */
    clearAllDirty(): void {
        this.dirtyTracker.clearAll();
    }

    /**
     * Get entities despawned since the last flushDespawned() call.
     * Returns a subarray view, zero allocations.
     */
    getDespawned(): Uint32Array {
        return this.despawnTracker.getDespawned();
    }

    /**
     * Clear the despawn tracker. Call once per tick after processing despawns.
     */
    flushDespawned(): void {
        this.despawnTracker.flush();
    }

    /**
     * Serialize an entity's components to a new buffer. Defaults to every
     * registered component; pass a subset to limit it.
     */
    serialize(
        entityId: Entity,
        components: Component<any>[] = this.componentManager.getComponents() as Component<any>[],
    ): Uint8Array {
        const buffer = new Uint8Array(entityByteSize(this, entityId, components));
        serializeEntity(this, entityId, components, new DataView(buffer.buffer), 0);
        return buffer;
    }

    /**
     * Restore an entity's components from a buffer produced by `serialize`.
     */
    restore(
        entityId: Entity,
        data: Uint8Array,
        components: Component<any>[] = this.componentManager.getComponents() as Component<any>[],
    ): void {
        restoreEntity(
            this,
            entityId,
            components,
            new DataView(data.buffer, data.byteOffset, data.byteLength),
            0,
        );
    }

    /**
     * Write an entity's components into `dv` at `offset`. Returns the offset past
     * the written bytes. The caller owns and reuses the DataView across entities.
     */
    writeEntity(entityId: Entity, components: Component<any>[], dv: DataView, offset: number): number {
        return serializeEntity(this, entityId, components, dv, offset);
    }

    /**
     * Read an entity's components from `dv` at `offset`. Returns the offset past
     * the read bytes.
     */
    readEntity(entityId: Entity, components: Component<any>[], dv: DataView, offset: number): number {
        return restoreEntity(this, entityId, components, dv, offset);
    }

    /**
     * Get direct access to a component field's TypedArray for maximum performance.
     * Bypasses the get/update API. No bounds checking or type safety: ensure the
     * entity has the component.
     */
    getFieldArray<T extends object>(
        component: Component<T>,
        fieldName: keyof T,
    ): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array {
        return this.componentManager.getFieldArray(component, fieldName);
    }

    /**
     * Get a typed-array bundle for every field of a component.
     *
     * Returns the same frozen object on every call, built once at registration.
     * Each field name maps to its underlying typed array with the exact element
     * type inferred from the schema. Bypasses dirty tracking: for networked
     * components use `ctx.fields()` in `murow/netcode`, or call
     * `world.markDirty(entity, index)` yourself.
     *
     * @example
     * ```ts
     * const pos = world.fields(Position);
     * pos.x[entity] += velocity.x * dt;
     * ```
     */
    fields<T extends object, S extends Schema<T>>(
        component: Component<T, S>,
    ): Readonly<{ [K in keyof S]: ArrayFromField<S[K]> }> {
        return this.componentManager.fields(component);
    }

    /**
     * Create an EntityHandle wrapper for fluent, chainable entity operations.
     */
    entity(entityId: Entity): EntityHandle {
        return new EntityHandle(this, entityId);
    }

    /**
     * Component stores indexed by component world-index. Read directly by
     * EntityHandle for low-overhead field access.
     */
    get componentStoresArray(): (ComponentStore<any> | undefined)[] {
        return this.componentManager.stores;
    }

    /**
     * Compute the query bitmask for a set of components. Used by SystemBuilder.
     * @internal
     */
    private getQueryMask(components: Component<any>[]): number[] | null {
        return this.queryManager.getQueryMask(components);
    }

    /**
     * Get a query mask key for a set of components. Used by SystemBuilder.
     * @internal
     */
    private _getQueryMaskKey(components: Component<any>[]): string {
        return this.queryManager.getQueryMaskKey(components);
    }

    /**
     * Query entities by precomputed mask key and mask. Used by ExecutableSystem.
     * @internal
     */
    private _queryByMaskKey(maskKey: string, requiredMask: number[]): readonly Entity[] {
        return this.queryManager.queryByMaskKey(maskKey, requiredMask);
    }
}

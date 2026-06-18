import type { ArrayFromField, Schema } from "../../core/binary-codec";
import { Component } from "./component";
import { ComponentStore } from "./component-store";
import type { Entity } from "../entity/entity-manager";
import {
    createEntitySet,
    setHas,
    setInsert,
    setRemove,
    type EntitySet,
} from "../entity/entity-set";

type FieldBundle = Record<
    string,
    Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array
>;

/**
 * Owns component registration and per-entity component membership: the stores
 * (one per component), the per-entity component bitmask words, the per-component
 * member lists (entities that have component i), and the frozen field bundles.
 *
 * Registration is idempotent and widens the mask words on demand, so the same
 * path serves both construction-time and dynamic `addComponent`.
 */
export class ComponentManager {
    private components: Component<any>[] = [];
    public stores: (ComponentStore<any> | undefined)[] = [];

    private componentMasks: Uint32Array[] = [];
    private componentMasks0!: Uint32Array;
    private numMaskWords: number = 0;

    private members: EntitySet[] = [];
    private fieldsByComponent: FieldBundle[] = [];

    constructor(
        private readonly maxEntities: number,
        private readonly worldId: string,
    ) {}

    /**
     * Register a component, allocating its store, member list, field bundle, and
     * widening the mask words if the new index crosses a 32-bit boundary.
     * Idempotent: returns the existing index if already registered here.
     */
    register(component: Component<any>): number {
        const existing = component.__worldIndex;
        if (existing !== undefined && this.components[existing] === component) {
            return existing;
        }

        const index = this.components.length;
        this.components.push(component);
        component.__worldIndex = index;

        const requiredWords = (index >>> 5) + 1;
        while (this.componentMasks.length < requiredWords) {
            this.componentMasks.push(new Uint32Array(this.maxEntities));
        }
        this.numMaskWords = this.componentMasks.length;
        this.componentMasks0 = this.componentMasks[0]!;

        const store = new ComponentStore(component, this.maxEntities);
        this.stores[index] = store;

        this.members[index] = createEntitySet(this.maxEntities);

        const bundle: FieldBundle = {};
        for (let i = 0; i < component.fieldNames.length; i++) {
            const fieldName = component.fieldNames[i];
            bundle[fieldName as string] = store.getFieldArray(fieldName);
        }
        Object.freeze(bundle);
        this.fieldsByComponent[index] = bundle;

        return index;
    }

    getComponentIndex(component: Component<any>): number {
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

    getComponents(): readonly Component<any>[] {
        return this.components;
    }

    getStore(index: number): ComponentStore<any> {
        return this.stores[index]!;
    }

    getMembers(index: number): EntitySet {
        return this.members[index]!;
    }

    setComponentBit(entity: Entity, componentIndex: number): void {
        const wordIndex = componentIndex >>> 5;
        const bitIndex = componentIndex & 31;
        this.componentMasks[wordIndex]![entity] |= 1 << bitIndex;
    }

    clearComponentBit(entity: Entity, componentIndex: number): void {
        const wordIndex = componentIndex >>> 5;
        const bitIndex = componentIndex & 31;
        this.componentMasks[wordIndex]![entity] &= ~(1 << bitIndex);
    }

    hasComponentBit(entity: Entity, componentIndex: number): boolean {
        const wordIndex = componentIndex >>> 5;
        const bitIndex = componentIndex & 31;
        return (this.componentMasks[wordIndex]![entity]! & (1 << bitIndex)) !== 0;
    }

    clearAllComponentBits(entity: Entity): void {
        if (this.numMaskWords === 1) {
            this.componentMasks0[entity] = 0;
        } else if (this.numMaskWords === 2) {
            this.componentMasks0[entity] = 0;
            this.componentMasks[1]![entity] = 0;
        } else if (this.numMaskWords === 3) {
            this.componentMasks0[entity] = 0;
            this.componentMasks[1]![entity] = 0;
            this.componentMasks[2]![entity] = 0;
        } else {
            for (let i = 0; i < this.numMaskWords; i++) {
                this.componentMasks[i]![entity] = 0;
            }
        }
    }

    /**
     * True if the entity has all components in `mask`. Unrolled for the common
     * <=128-component cases (1-4 mask words).
     */
    matchesComponentMask(entity: Entity, mask: number[]): boolean {
        const len = mask.length;

        if (len === 1) {
            return (this.componentMasks0[entity]! & mask[0]!) === mask[0];
        }

        if (len === 2) {
            return (
                (this.componentMasks0[entity]! & mask[0]!) === mask[0] &&
                (this.componentMasks[1]![entity]! & mask[1]!) === mask[1]
            );
        }

        if (len === 3) {
            return (
                (this.componentMasks0[entity]! & mask[0]!) === mask[0] &&
                (this.componentMasks[1]![entity]! & mask[1]!) === mask[1] &&
                (this.componentMasks[2]![entity]! & mask[2]!) === mask[2]
            );
        }

        if (len === 4) {
            return (
                (this.componentMasks0[entity]! & mask[0]!) === mask[0] &&
                (this.componentMasks[1]![entity]! & mask[1]!) === mask[1] &&
                (this.componentMasks[2]![entity]! & mask[2]!) === mask[2] &&
                (this.componentMasks[3]![entity]! & mask[3]!) === mask[3]
            );
        }

        for (let i = 0; i < len; i++) {
            if ((this.componentMasks[i]![entity]! & mask[i]!) !== mask[i]) {
                return false;
            }
        }
        return true;
    }

    /** Set the component bit, write its data, and track membership. */
    add<T extends object>(entity: Entity, component: Component<T>, data: T): number {
        const index = this.getComponentIndex(component);
        this.setComponentBit(entity, index);
        this.stores[index]!.set(entity, data);

        const members = this.members[index]!;
        if (!setHas(members, entity)) setInsert(members, entity);

        return index;
    }

    /** Clear the component bit, wipe its data, and drop membership. -1 if unregistered. */
    remove<T extends object>(entity: Entity, component: Component<T>): number {
        const index = component.__worldIndex;
        if (index === undefined) return -1;

        this.clearComponentBit(entity, index);
        this.stores[index]?.clear(entity);

        const members = this.members[index]!;
        if (setHas(members, entity)) setRemove(members, entity);

        return index;
    }

    /** Clear every component the entity holds (stores, member lists, bits). */
    clearEntity(entity: Entity): void {
        const count = this.components.length;
        for (let i = 0; i < count; i++) {
            if (this.hasComponentBit(entity, i)) {
                this.stores[i]!.clear(entity);
                setRemove(this.members[i]!, entity);
            }
        }
        this.clearAllComponentBits(entity);
    }

    getFieldArray<T extends object>(
        component: Component<T>,
        fieldName: keyof T,
    ): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array {
        const index = this.getComponentIndex(component);
        return this.stores[index]!.getFieldArray(fieldName);
    }

    fields<T extends object, S extends Schema<T>>(
        component: Component<T, S>,
    ): Readonly<{ [K in keyof S]: ArrayFromField<S[K]> }> {
        const index = this.getComponentIndex(component);
        return this.fieldsByComponent[index] as Readonly<{
            [K in keyof S]: ArrayFromField<S[K]>;
        }>;
    }

    getEntityComponentNames(entity: Entity): string[] {
        const result: string[] = [];
        for (let i = 0; i < this.components.length; i++) {
            if (this.hasComponentBit(entity, i)) {
                result.push(this.components[i]!.name);
            }
        }
        return result;
    }
}

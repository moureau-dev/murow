/**
 * Dirty-state checker for netcode tests and debug builds.
 *
 * Reads the ECS dirty flags that drive snapshots. It is intentionally small:
 * count what is dirty, assert it is clean, or assert one entity/component is
 * dirty. It does not allocate on the read path and does not change state.
 */

import type { Component, Entity, World } from 'murow/ecs';

/** One dirty component and the entities marked for it. */
export interface DirtyComponentReport {
    readonly component: string;
    readonly entities: readonly Entity[];
}

/**
 * Read-only view over a world's dirty bits for a chosen component set.
 */
export class DirtyStateChecker {
    private readonly world: World;
    private readonly components: readonly Component<any>[];

    constructor(world: World, components?: readonly Component<any>[]) {
        this.world = world;
        this.components = components ?? (world.getComponents() as readonly Component<any>[]);
    }

    /** Number of dirty (entity, component) entries. */
    count(): number {
        let total = 0;
        for (let i = 0; i < this.components.length; i++) {
            this.world.forEachDirty(this.components[i]!, () => { total += 1; });
        }
        return total;
    }

    /** Dirty entities for one component. Allocates; debug and tests only. */
    entities(component: Component<any>): Entity[] {
        const out: Entity[] = [];
        this.world.forEachDirty(component, (entity) => { out.push(entity); });
        return out;
    }

    /** True when the entity is dirty for the component. */
    isDirty(entity: Entity, component: Component<any>): boolean {
        return this.world.isDirty(entity, component);
    }

    /** Every dirty component, with its entities. Allocates; debug and tests only. */
    report(): DirtyComponentReport[] {
        const out: DirtyComponentReport[] = [];
        for (let i = 0; i < this.components.length; i++) {
            const component = this.components[i]!;
            const entities = this.entities(component);
            if (entities.length === 0) continue;
            out.push({
                component: (component as { name?: string }).name ?? String(component.__worldIndex),
                entities,
            });
        }
        return out;
    }

    /** Throw when anything is dirty. */
    assertClean(context = 'dirty state'): void {
        const count = this.count();
        if (count === 0) return;
        const parts = this.report().map((entry) => `${entry.component}=[${entry.entities.join(',')}]`);
        throw new Error(`${context}: ${count} dirty entr${count === 1 ? 'y' : 'ies'}: ${parts.join(' ')}`);
    }

    /** Throw when the entity/component pair is not dirty. */
    assertDirty(entity: Entity, component: Component<any>, context = 'dirty state'): void {
        if (this.world.isDirty(entity, component)) return;
        throw new Error(`${context}: entity ${entity} is not dirty for ${(component as { name?: string }).name ?? 'component'}`);
    }
}

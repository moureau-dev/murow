import type { Entity } from "./entity-manager";

/**
 * A dense set of entities with O(1) membership. `buffer` is the dense list;
 * `positions` maps entity -> its index in `buffer`, valid only when
 * `buffer[positions[e]] === e` (so stale entries are harmless, no reset needed).
 */
export interface EntitySet {
    buffer: Entity[];
    positions: Int32Array;
}

export function createEntitySet(maxEntities: number): EntitySet {
    return { buffer: [], positions: new Int32Array(maxEntities) };
}

export function setHas(set: EntitySet, entity: Entity): boolean {
    const idx = set.positions[entity]!;
    return idx < set.buffer.length && set.buffer[idx] === entity;
}

export function setInsert(set: EntitySet, entity: Entity): void {
    set.positions[entity] = set.buffer.length;
    set.buffer.push(entity);
}

export function setRemove(set: EntitySet, entity: Entity): void {
    const buffer = set.buffer;
    const idx = set.positions[entity]!;
    const lastEntity = buffer[buffer.length - 1]!;
    buffer[idx] = lastEntity;
    set.positions[lastEntity] = idx;
    buffer.pop();
}

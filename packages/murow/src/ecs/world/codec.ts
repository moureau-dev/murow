import type { Component } from "../components/component";
import type { World } from "./world";

/**
 * Per-entity binary serialization for the ECS.
 *
 * Layout per entity: a presence bitmask over `components` (one bit per list
 * position, `ceil(components.length / 32)` words, little-endian) followed by
 * the packed fields of each component the entity has, in list order. Restore
 * must use the same `components` list.
 *
 * Handles scalar (single-value) component fields, matching the ECS store's
 * scalar SoA layout.
 */

function maskWords(count: number): number {
    return (count + 31) >>> 5;
}

/** Serialized byte size of `entityId` against `components`. */
export function entityByteSize(world: World, entityId: number, components: Component<any>[]): number {
    let size = maskWords(components.length) * 4;
    for (let ci = 0; ci < components.length; ci++) {
        if (world.has(entityId, components[ci])) size += components[ci].size;
    }
    return size;
}

/**
 * Write `entityId`'s present components into `dv` at `offset`. Returns the
 * offset past the written bytes.
 */
export function serializeEntity(
    world: World,
    entityId: number,
    components: Component<any>[],
    dv: DataView,
    offset: number,
): number {
    const words = maskWords(components.length);
    const maskStart = offset;
    let off = offset + words * 4;

    for (let w = 0; w < words; w++) {
        let word = 0;
        const base = w * 32;
        const end = Math.min(base + 32, components.length);
        for (let ci = base; ci < end; ci++) {
            if (world.has(entityId, components[ci])) word |= 1 << (ci - base);
        }
        dv.setUint32(maskStart + w * 4, word >>> 0, true);
    }

    for (let ci = 0; ci < components.length; ci++) {
        const c = components[ci];
        if (!world.has(entityId, c)) continue;
        off = writeFields(world, entityId, c, dv, off);
    }
    return off;
}

/**
 * Read components written by `serializeEntity` from `dv` at `offset` into
 * `entityId`, adding any the entity does not have. Returns the offset past
 * the read bytes.
 */
export function restoreEntity(
    world: World,
    entityId: number,
    components: Component<any>[],
    dv: DataView,
    offset: number,
): number {
    const words = maskWords(components.length);
    const maskStart = offset;
    let off = offset + words * 4;

    let word = 0;
    for (let ci = 0; ci < components.length; ci++) {
        if ((ci & 31) === 0) word = dv.getUint32(maskStart + (ci >>> 5) * 4, true);
        if ((word & (1 << (ci & 31))) === 0) continue;
        off = readFields(world, entityId, components[ci], dv, off);
    }
    return off;
}

function writeFields(world: World, entityId: number, c: Component<any>, dv: DataView, off: number): number {
    const schema = c.schema as Record<string, any>;
    const fieldNames = c.fieldNames as string[];
    const fieldArrays = world.fields(c) as Record<string, any>;
    for (let fi = 0; fi < fieldNames.length; fi++) {
        const fn = fieldNames[fi];
        const field = schema[fn];
        field.write(dv, off, fieldArrays[fn][entityId]);
        off += field.size;
    }
    return off;
}

function readFields(world: World, entityId: number, c: Component<any>, dv: DataView, off: number): number {
    const schema = c.schema as Record<string, any>;
    const fieldNames = c.fieldNames as string[];
    const update: Record<string, unknown> = {};
    for (let fi = 0; fi < fieldNames.length; fi++) {
        const fn = fieldNames[fi];
        const field = schema[fn];
        update[fn] = field.read(dv, off);
        off += field.size;
    }
    if (world.has(entityId, c)) world.update(entityId, c, update as any);
    else world.add(entityId, c, update as any);
    return off;
}

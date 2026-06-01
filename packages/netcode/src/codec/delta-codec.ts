import type { Component, World } from 'murow/ecs';

/**
 * Snapshot delta wire format.
 *
 *   header   : tick u32 | clientAckTick u32 | entityCount u16 | despawnCount u16
 *   entities : repeated [ entityId u32 | bitmask u32 * N | fields packed by schema ]
 *   despawns : repeated [ entityId u32 ]
 *
 * `clientAckTick` is the highest client-stamped tick the server has applied
 * for this peer. The reconciler uses it (not the server tick) to drop
 * confirmed predictions. Server and client tick counters are independent.
 */

const HEADER_BYTES = 4 + 4 + 4 + 2 + 2;

function readU32(dv: DataView, off: number, end: number): number {
  if (off + 4 > end) throw new RangeError('readU32: out of bounds');
  return dv.getUint32(off, true);
}

function readU16(dv: DataView, off: number, end: number): number {
  if (off + 2 > end) throw new RangeError('readU16: out of bounds');
  return dv.getUint16(off, true);
}

export function encodeDelta(
    world: World,
    tick: number,
    entities: number[],
    components: Component<any>[],
    numMaskWords: number,
    despawned: number[] = [],
    clientAckTick: number = 0,
    configHash: number = 0,
): Uint8Array {
    const perEntityMasks: Uint32Array[] = new Array(entities.length);
    const perEntityBitmaskBytes = numMaskWords * 4;

    let bodyBytes = 0;
    for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const mask = new Uint32Array(numMaskWords);
        let componentBytes = 0;
        for (let ci = 0; ci < components.length; ci++) {
            const c = components[ci];
            if (!world.has(eid, c)) continue;
            const wordIndex = ci >>> 5;
            const bitIndex = ci & 31;
            mask[wordIndex] |= 1 << bitIndex;
            componentBytes += c.size;
        }
        perEntityMasks[i] = mask;
        bodyBytes += 4 + perEntityBitmaskBytes + componentBytes;
    }

    const despawnBytes = despawned.length * 4;
    const buf = new Uint8Array(HEADER_BYTES + bodyBytes + despawnBytes);
    const dv = new DataView(buf.buffer);
    let off = 0;

    dv.setUint32(off, configHash >>> 0, true); off += 4;
    dv.setUint32(off, tick >>> 0, true); off += 4;
    dv.setUint32(off, clientAckTick >>> 0, true); off += 4;
    dv.setUint16(off, entities.length, true); off += 2;
    dv.setUint16(off, despawned.length, true); off += 2;

    // Pre-resolve per-component metadata so the hot inner loop avoids
    // re-allocating a Readonly<T> view via `world.get(eid, c)` for every
    // entity. Each component gets:
    //   - fieldArrays: the typed-array bundle (world.fields(c))
    //   - allScalar: true if every field is single-element-per-entity, so
    //                we can read via `fieldArrays[name][eid]` directly.
    //                false if any field is composite (vec/string) - in
    //                which case we fall back to `world.get` for that
    //                component (still allocation-free thanks to the
    //                ComponentStore reusable-object pattern).
    const componentFieldArrays: (Record<string, any>)[] = new Array(components.length);
    const componentSchemas: (Record<string, any>)[] = new Array(components.length);
    const componentAllScalar: boolean[] = new Array(components.length);
    const maxEntities = world.getMaxEntities();
    for (let ci = 0; ci < components.length; ci++) {
        const c = components[ci];
        const fieldArrays = world.fields(c) as Record<string, any>;
        componentFieldArrays[ci] = fieldArrays;
        componentSchemas[ci] = c.schema as Record<string, any>;
        let allScalar = true;
        for (let fi = 0; fi < c.fieldNames.length; fi++) {
            const fname = c.fieldNames[fi] as string;
            if (fieldArrays[fname].length !== maxEntities) {
                allScalar = false;
                break;
            }
        }
        componentAllScalar[ci] = allScalar;
    }

    for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const mask = perEntityMasks[i];

        dv.setUint32(off, eid >>> 0, true); off += 4;

        for (let w = 0; w < numMaskWords; w++) {
            dv.setUint32(off, mask[w], true); off += 4;
        }

        for (let ci = 0; ci < components.length; ci++) {
            const wordIndex = ci >>> 5;
            const bitIndex = ci & 31;
            if ((mask[wordIndex] & (1 << bitIndex)) === 0) continue;

            const c = components[ci];
            const fieldArrays = componentFieldArrays[ci];
            const schema = componentSchemas[ci];
            const fieldNames = c.fieldNames as string[];

            if (componentAllScalar[ci]) {
                // Fast path: direct typed-array reads per field.
                for (let fi = 0; fi < fieldNames.length; fi++) {
                    const fieldName = fieldNames[fi];
                    const field = schema[fieldName];
                    field.write(dv, off, fieldArrays[fieldName][eid]);
                    off += field.size;
                }
            } else {
                // Composite-field fallback: assemble the value via world.get.
                const data = world.get(eid, c) as Record<string, unknown>;
                for (let fi = 0; fi < fieldNames.length; fi++) {
                    const fieldName = fieldNames[fi];
                    const field = schema[fieldName];
                    field.write(dv, off, data[fieldName]);
                    off += field.size;
                }
            }
        }
    }

    for (let i = 0; i < despawned.length; i++) {
        dv.setUint32(off, despawned[i] >>> 0, true); off += 4;
    }

    return buf;
}

export interface DecodedDelta {
    configHash: number;
    tick: number;
    clientAckTick: number;
    entityIds: number[];
    serverEntityIds: number[];
    despawnedServerIds: number[];
    valuesByServerEntity: Map<number, Map<Component<any>, Record<string, any>>>;
}

export function decodeDelta(
    world: World,
    buf: Uint8Array,
    components: Component<any>[],
    numMaskWords: number,
    ensureEntity: (serverEntityId: number, presentComponents: Component<any>[]) => number,
    /**
     * Return false to skip overwriting this entity's component values.
     * Components missing on the entity are still archetype-initialized
     * either way so the local entity has the right shape.
     */
    shouldApply: (localEntity: number) => boolean = () => true,
): DecodedDelta {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const end = buf.byteLength;
    let off = 0;

    const configHash = readU32(dv, off, end); off += 4;
    const tick = readU32(dv, off, end); off += 4;
    const clientAckTick = readU32(dv, off, end); off += 4;
    const entityCount = Math.min(readU16(dv, off, end), world.getMaxEntities()); off += 2;
    const despawnCount = Math.min(readU16(dv, off, end), world.getMaxEntities()); off += 2;

    const localEntityIds: number[] = [];
    const serverEntityIds: number[] = [];
    const valuesByServerEntity = new Map<number, Map<Component<any>, Record<string, any>>>();

    for (let i = 0; i < entityCount; i++) {
        const serverEid = readU32(dv, off, end); off += 4;
        serverEntityIds.push(serverEid);

        const mask = new Uint32Array(numMaskWords);
        for (let w = 0; w < numMaskWords; w++) {
            mask[w] = readU32(dv, off, end); off += 4;
        }

        const present: Component<any>[] = [];
        for (let ci = 0; ci < components.length; ci++) {
            const wordIndex = ci >>> 5;
            const bitIndex = ci & 31;
            if ((mask[wordIndex] & (1 << bitIndex)) !== 0) {
                present.push(components[ci]);
            }
        }

        const localEid = ensureEntity(serverEid, present);
        localEntityIds.push(localEid);

        const applyToWorld = shouldApply(localEid);
        const compMap = new Map<Component<any>, Record<string, any>>();
        for (const c of present) {
            const update: Record<string, any> = {};
            for (const fieldName of c.fieldNames as string[]) {
                const field = (c.schema as any)[fieldName];
                update[fieldName] = field.read(dv, off);
                off += field.size;
            }
            compMap.set(c, update);
            if (applyToWorld) {
                if (!world.has(localEid, c)) {
                    world.add(localEid, c, update as any);
                } else {
                    world.update(localEid, c, update as any);
                }
            } else if (!world.has(localEid, c)) {
                world.add(localEid, c, update as any);
            }
        }
        valuesByServerEntity.set(serverEid, compMap);
    }

    const despawnedServerIds: number[] = [];
    for (let i = 0; i < despawnCount; i++) {
        despawnedServerIds.push(readU32(dv, off, end));
        off += 4;
    }

    return {
        configHash,
        tick,
        clientAckTick,
        entityIds: localEntityIds,
        serverEntityIds,
        despawnedServerIds,
        valuesByServerEntity,
    };
}

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

const HEADER_BYTES = 4 + 4 + 2 + 2;

export interface QuantSpec {
    readonly min: number;
    readonly max: number;
    readonly bits?: 8 | 16;
}

interface ResolvedQuant {
    readonly min: number;
    readonly max: number;
    readonly maxInt: number;
    readonly bytes: number;
}

function resolveQuant(sync: unknown, fieldName: string): ResolvedQuant | null {
    const spec = (sync as { quantize?: Record<string, QuantSpec> } | undefined)?.quantize?.[fieldName];
    if (spec === undefined) return null;
    const bits = spec.bits ?? 16;
    return { min: spec.min, max: spec.max, maxInt: (1 << bits) - 1, bytes: bits / 8 };
}

function quantPack(value: number, q: ResolvedQuant): number {
    let i = Math.round(((value - q.min) / (q.max - q.min)) * q.maxInt);
    if (i < 0) i = 0;
    else if (i > q.maxInt) i = q.maxInt;
    return i;
}

function quantUnpack(i: number, q: ResolvedQuant): number {
    return q.min + (i / q.maxInt) * (q.max - q.min);
}

export function encodeDelta(
    world: World,
    tick: number,
    entities: number[],
    components: Component<any>[],
    numMaskWords: number,
    despawned: number[] = [],
    clientAckTick: number = 0,
    includeComponent: (entity: number, component: Component<any>) => boolean = () => true,
): Uint8Array {
    const perEntityBitmaskBytes = numMaskWords * 4;

    // Pre-resolve per-component metadata once: field arrays, schema, whether
    // every field is a single-element scalar, and the per-field wire size
    // (quantized fields shrink; the store stays full-width).
    const componentFieldArrays: (Record<string, any>)[] = new Array(components.length);
    const componentSchemas: (Record<string, any>)[] = new Array(components.length);
    const componentAllScalar: boolean[] = new Array(components.length);
    const componentQuants: (ResolvedQuant | null)[][] = new Array(components.length);
    const componentWireSizes: number[][] = new Array(components.length);
    const maxEntities = world.getMaxEntities();
    for (let ci = 0; ci < components.length; ci++) {
        const c = components[ci];
        const fieldArrays = world.fields(c) as Record<string, any>;
        componentFieldArrays[ci] = fieldArrays;
        componentSchemas[ci] = c.schema as Record<string, any>;
        const fieldNames = c.fieldNames as string[];
        const sync = (c as any).__sync;
        const quants: (ResolvedQuant | null)[] = new Array(fieldNames.length);
        const wireSizes: number[] = new Array(fieldNames.length);
        let allScalar = true;
        for (let fi = 0; fi < fieldNames.length; fi++) {
            const fname = fieldNames[fi];
            const q = resolveQuant(sync, fname);
            quants[fi] = q;
            wireSizes[fi] = q ? q.bytes : (c.schema as any)[fname].size;
            if (fieldArrays[fname].length !== maxEntities) allScalar = false;
        }
        componentQuants[ci] = quants;
        componentWireSizes[ci] = wireSizes;
        componentAllScalar[ci] = allScalar;
    }

    const perEntityMasks: Uint32Array[] = new Array(entities.length);
    let bodyBytes = 0;
    for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const mask = new Uint32Array(numMaskWords);
        let componentBytes = 0;
        for (let ci = 0; ci < components.length; ci++) {
            const c = components[ci];
            if (!world.has(eid, c)) continue;
            if (!includeComponent(eid, c)) continue;
            mask[ci >>> 5] |= 1 << (ci & 31);
            const ws = componentWireSizes[ci];
            for (let fi = 0; fi < ws.length; fi++) componentBytes += ws[fi];
        }
        perEntityMasks[i] = mask;
        bodyBytes += 4 + perEntityBitmaskBytes + componentBytes;
    }

    const despawnBytes = despawned.length * 4;
    const buf = new Uint8Array(HEADER_BYTES + bodyBytes + despawnBytes);
    const dv = new DataView(buf.buffer);
    let off = 0;

    dv.setUint32(off, tick >>> 0, true); off += 4;
    dv.setUint32(off, clientAckTick >>> 0, true); off += 4;
    dv.setUint16(off, entities.length, true); off += 2;
    dv.setUint16(off, despawned.length, true); off += 2;

    for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const mask = perEntityMasks[i];

        dv.setUint32(off, eid >>> 0, true); off += 4;
        for (let w = 0; w < numMaskWords; w++) {
            dv.setUint32(off, mask[w], true); off += 4;
        }

        for (let ci = 0; ci < components.length; ci++) {
            if ((mask[ci >>> 5] & (1 << (ci & 31))) === 0) continue;

            const c = components[ci];
            const fieldArrays = componentFieldArrays[ci];
            const schema = componentSchemas[ci];
            const quants = componentQuants[ci];
            const fieldNames = c.fieldNames as string[];
            const data = componentAllScalar[ci] ? null : (world.get(eid, c) as Record<string, unknown>);

            for (let fi = 0; fi < fieldNames.length; fi++) {
                const fieldName = fieldNames[fi];
                const value = componentAllScalar[ci] ? fieldArrays[fieldName][eid] : data![fieldName];
                const q = quants[fi];
                if (q !== null) {
                    const iv = quantPack(value as number, q);
                    if (q.bytes === 1) { dv.setUint8(off, iv); off += 1; }
                    else { dv.setUint16(off, iv, true); off += 2; }
                } else {
                    const field = schema[fieldName];
                    field.write(dv, off, value);
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
    let off = 0;

    const tick = dv.getUint32(off, true); off += 4;
    const clientAckTick = dv.getUint32(off, true); off += 4;
    const entityCount = dv.getUint16(off, true); off += 2;
    const despawnCount = dv.getUint16(off, true); off += 2;

    const localEntityIds: number[] = [];
    const serverEntityIds: number[] = [];
    const valuesByServerEntity = new Map<number, Map<Component<any>, Record<string, any>>>();

    for (let i = 0; i < entityCount; i++) {
        const serverEid = dv.getUint32(off, true); off += 4;
        serverEntityIds.push(serverEid);

        const mask = new Uint32Array(numMaskWords);
        for (let w = 0; w < numMaskWords; w++) {
            mask[w] = dv.getUint32(off, true); off += 4;
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
            const sync = (c as any).__sync;
            for (const fieldName of c.fieldNames as string[]) {
                const q = resolveQuant(sync, fieldName);
                if (q !== null) {
                    const iv = q.bytes === 1 ? dv.getUint8(off) : dv.getUint16(off, true);
                    off += q.bytes;
                    update[fieldName] = quantUnpack(iv, q);
                } else {
                    const field = (c.schema as any)[fieldName];
                    update[fieldName] = field.read(dv, off);
                    off += field.size;
                }
            }
            compMap.set(c, update);
            if (applyToWorld) {
                if (!world.has(localEid, c)) {
                    world.add(localEid, c, update as any);
                } else {
                    world.update(localEid, c, update as any);
                }
            } else if (!world.has(localEid, c)) {
                // First-appearance archetype init even when skipping
                // updates, so subsequent reads find the component.
                world.add(localEid, c, update as any);
            }
        }
        valuesByServerEntity.set(serverEid, compMap);
    }

    const despawnedServerIds: number[] = [];
    for (let i = 0; i < despawnCount; i++) {
        despawnedServerIds.push(dv.getUint32(off, true));
        off += 4;
    }

    return {
        tick,
        clientAckTick,
        entityIds: localEntityIds,
        serverEntityIds,
        despawnedServerIds,
        valuesByServerEntity,
    };
}

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

/** Reserved leading byte for the transport message type (e.g. MSG_SNAPSHOT). */
const ENVELOPE_BYTES = 1;

/** Precomputed per-(world, components) encode metadata. Build once, reuse. */
export interface DeltaSchema {
    readonly components: Component<any>[];
    readonly numMaskWords: number;
    readonly maskBytes: number;
    readonly fieldArrays: Record<string, any>[];
    readonly schemas: Record<string, any>[];
    readonly allScalar: boolean[];
    readonly quants: (ResolvedQuant | null)[][];
    readonly wireSizes: number[][];
    readonly componentBytes: number[];
}

/** Resolve per-component field arrays, schemas, quants and wire sizes once. */
export function buildDeltaSchema(
    world: World,
    components: Component<any>[],
    numMaskWords: number,
): DeltaSchema {
    const n = components.length;
    const fieldArrays = new Array<Record<string, any>>(n);
    const schemas = new Array<Record<string, any>>(n);
    const allScalar = new Array<boolean>(n);
    const quants = new Array<(ResolvedQuant | null)[]>(n);
    const wireSizes = new Array<number[]>(n);
    const componentBytes = new Array<number>(n);
    const maxEntities = world.getMaxEntities();
    for (let ci = 0; ci < n; ci++) {
        const c = components[ci]!;
        const fa = world.fields(c) as Record<string, any>;
        fieldArrays[ci] = fa;
        schemas[ci] = c.schema as Record<string, any>;
        const fieldNames = c.fieldNames as string[];
        const sync = (c as any).__sync;
        const q = new Array<ResolvedQuant | null>(fieldNames.length);
        const ws = new Array<number>(fieldNames.length);
        let all = true;
        let bytes = 0;
        for (let fi = 0; fi < fieldNames.length; fi++) {
            const fname = fieldNames[fi]!;
            const quant = resolveQuant(sync, fname);
            q[fi] = quant;
            const w = quant ? quant.bytes : (c.schema as any)[fname].size;
            ws[fi] = w;
            bytes += w;
            if (fa[fname].length !== maxEntities) all = false;
        }
        quants[ci] = q;
        wireSizes[ci] = ws;
        allScalar[ci] = all;
        componentBytes[ci] = bytes;
    }
    return {
        components,
        numMaskWords,
        maskBytes: numMaskWords * 4,
        fieldArrays,
        schemas,
        allScalar,
        quants,
        wireSizes,
        componentBytes,
    };
}

const EMPTY_DESPAWNS = new Uint32Array(0);
const INCLUDE_ALL = (): boolean => true;

/**
 * Zero-alloc snapshot encoder. Owns a growable output buffer (with a reserved
 * leading envelope byte) and a reusable mask buffer, so no allocation happens
 * after the warm-up tick. `encode` returns a view into the owned buffer; set
 * `view[0]` to the message type and send it. The transport contract lets the
 * caller reuse the buffer once `send()` returns, so one encoder serves every
 * peer and tick.
 */
export class SnapshotEncoder {
    private readonly schema: DeltaSchema;
    private masks = new Uint32Array(0);
    private buf = new Uint8Array(0);

    constructor(schema: DeltaSchema) {
        this.schema = schema;
    }

    encode(
        world: World,
        tick: number,
        entities: number[],
        despawned: ArrayLike<number> = EMPTY_DESPAWNS,
        clientAckTick: number = 0,
        includeComponent: (entity: number, component: Component<any>) => boolean = INCLUDE_ALL,
    ): Uint8Array {
        const s = this.schema;
        const components = s.components;
        const numMaskWords = s.numMaskWords;

        const maskCount = entities.length * numMaskWords;
        if (this.masks.length < maskCount) this.masks = new Uint32Array(maskCount);
        const masks = this.masks;
        masks.fill(0, 0, maskCount);

        let bodyBytes = 0;
        for (let i = 0; i < entities.length; i++) {
            const eid = entities[i]!;
            const base = i * numMaskWords;
            let componentBytes = 0;
            for (let ci = 0; ci < components.length; ci++) {
                const c = components[ci]!;
                if (!world.has(eid, c) || !includeComponent(eid, c)) continue;
                masks[base + (ci >>> 5)] |= 1 << (ci & 31);
                componentBytes += s.componentBytes[ci]!;
            }
            bodyBytes += 4 + s.maskBytes + componentBytes;
        }

        const total = ENVELOPE_BYTES + HEADER_BYTES + bodyBytes + despawned.length * 4;
        if (this.buf.length < total) this.buf = new Uint8Array(total + (total >> 1));
        const buf = this.buf;
        const dv = new DataView(buf.buffer);
        let off = ENVELOPE_BYTES;

        dv.setUint32(off, tick >>> 0, true); off += 4;
        dv.setUint32(off, clientAckTick >>> 0, true); off += 4;
        dv.setUint16(off, entities.length, true); off += 2;
        dv.setUint16(off, despawned.length, true); off += 2;

        for (let i = 0; i < entities.length; i++) {
            const eid = entities[i]!;
            const base = i * numMaskWords;
            dv.setUint32(off, eid >>> 0, true); off += 4;
            for (let w = 0; w < numMaskWords; w++) {
                dv.setUint32(off, masks[base + w]!, true); off += 4;
            }
            for (let ci = 0; ci < components.length; ci++) {
                if ((masks[base + (ci >>> 5)] & (1 << (ci & 31))) === 0) continue;
                const c = components[ci]!;
                const fieldArrays = s.fieldArrays[ci]!;
                const schema = s.schemas[ci]!;
                const quants = s.quants[ci]!;
                const fieldNames = c.fieldNames as string[];
                const data = s.allScalar[ci] ? null : (world.get(eid, c) as Record<string, unknown>);
                for (let fi = 0; fi < fieldNames.length; fi++) {
                    const fieldName = fieldNames[fi]!;
                    const value = s.allScalar[ci] ? fieldArrays[fieldName][eid] : data![fieldName];
                    const q = quants[fi]!;
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
            dv.setUint32(off, despawned[i]! >>> 0, true); off += 4;
        }

        return buf.subarray(0, total);
    }
}

/**
 * One-shot encode convenience (builds a schema each call). Prefer a reused
 * `SnapshotEncoder` in hot paths. Returns a view whose envelope byte is
 * stripped, so the payload starts at offset 0 (header first).
 */
export function encodeDelta(
    world: World,
    tick: number,
    entities: number[],
    components: Component<any>[],
    numMaskWords: number,
    despawned: number[] = [],
    clientAckTick: number = 0,
    includeComponent?: (entity: number, component: Component<any>) => boolean,
): Uint8Array {
    const schema = buildDeltaSchema(world, components, numMaskWords);
    const view = new SnapshotEncoder(schema).encode(
        world, tick, entities, despawned, clientAckTick, includeComponent,
    );
    return view.subarray(ENVELOPE_BYTES);
}


export interface DecodedDelta {
    tick: number;
    clientAckTick: number;
    entityIds: number[];
    serverEntityIds: number[];
    despawnedServerIds: number[];
    valuesByServerEntity: Map<number, (Record<string, any> | null)[]>;
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
    const valuesByServerEntity = new Map<number, (Record<string, any> | null)[]>();

    // Reused across entities: one mask buffer and two present lists per decode,
    // instead of a fresh allocation per entity.
    const mask = new Uint32Array(numMaskWords);
    const present: Component<any>[] = [];
    const presentIndex: number[] = [];

    for (let i = 0; i < entityCount; i++) {
        const serverEid = dv.getUint32(off, true); off += 4;
        serverEntityIds.push(serverEid);

        for (let w = 0; w < numMaskWords; w++) {
            mask[w] = dv.getUint32(off, true); off += 4;
        }

        present.length = 0;
        presentIndex.length = 0;
        for (let ci = 0; ci < components.length; ci++) {
            const wordIndex = ci >>> 5;
            const bitIndex = ci & 31;
            if ((mask[wordIndex] & (1 << bitIndex)) !== 0) {
                present.push(components[ci]);
                presentIndex.push(ci);
            }
        }

        const localEid = ensureEntity(serverEid, present);
        localEntityIds.push(localEid);

        const applyToWorld = shouldApply(localEid);
        const compMap: (Record<string, any> | null)[] = new Array(components.length).fill(null);
        for (let pi = 0; pi < present.length; pi++) {
            const c = present[pi]!;
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
            compMap[presentIndex[pi]!] = update;
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

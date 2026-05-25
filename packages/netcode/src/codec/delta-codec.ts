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

export function encodeDelta(
    world: World,
    tick: number,
    entities: number[],
    components: Component<any>[],
    numMaskWords: number,
    despawned: number[] = [],
    clientAckTick: number = 0,
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
            const wordIndex = ci >>> 5;
            const bitIndex = ci & 31;
            if ((mask[wordIndex] & (1 << bitIndex)) === 0) continue;

            const c = components[ci];
            const data = world.get(eid, c) as Record<string, unknown>;
            for (const fieldName of c.fieldNames as (keyof typeof data)[]) {
                const field = (c.schema as any)[fieldName];
                field.write(dv, off, data[fieldName]);
                off += field.size;
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

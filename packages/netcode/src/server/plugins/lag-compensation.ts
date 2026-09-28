import type { Component, Entity, World } from 'murow/ecs';
import type { ServerPlugin } from './plugin';

export interface LagCompensationOptions {
    /** Plugin identifier. Default `'lag-compensation'`. */
    name?: string;
    /** How far back to keep state history (ms). Default 500. */
    historyMs?: number;
    /** Tick rate of the simulation; used to size the ring buffer. */
    tickRate: number;
    /** Components whose history is recorded for rewind. */
    components: Component<any>[];
}

/** Frame header: tick u32 | entryCount u32, then packed entries. */
const HEADER_BYTES = 8;

/** Entities a freshly-allocated frame can hold before it has to grow. */
const INITIAL_ENTITIES = 64;

/**
 * A single recorded tick, held as one flat binary buffer:
 *
 *   [ tick u32 ][ entryCount u32 ]
 *   for each entry: [ entityId u32 ][ presence mask + packed fields ]
 *
 * The per-entry body is exactly `world.writeEntity`'s layout, so recording a
 * tick and restoring one are a single zero-allocation pass each. Frames grow
 * on demand and are then reused across the ring forever.
 */
interface Frame {
    tick: number;
    bytes: Uint8Array;
    dv: DataView;
}

function maskWords(count: number): number {
    return (count + 31) >>> 5;
}

/**
 * Records the configured components every tick for `historyMs` worth of
 * frames. `rewind(clientTick, fn)` overlays the historical state for the
 * duration of `fn`, then restores.
 *
 * The history is stored as a ring of preallocated binary frames rather than
 * per-tick `Map`s of cloned objects. Recording uses `world.writeEntity` and
 * restoring writes straight into the world's SoA arrays, both into
 * caller-owned `DataView`s, so steady-state ticks and rewinds allocate
 * nothing. Frames only allocate when the recorded entity set outgrows them,
 * after which the same buffers are reused for the life of the plugin.
 */
export class LagCompensation implements ServerPlugin {
    readonly name: string;
    readonly historyMs: number;
    readonly tickRate: number;
    private components: Component<any>[];
    private ringSize: number;
    private ringHead = 0;
    private currentTick = 0;
    private world: World | null = null;

    private frames: Frame[] = [];
    /** Bytes per entity entry, worst case (eid + full presence mask + all fields). */
    private entryStride = 4;
    private words = 1;
    private scratch = new Uint8Array(0);
    private scratchDv = new DataView(new ArrayBuffer(0));

    // Per-component field access, hoisted at mount so restore is a direct
    // typed-array write (no `world.get`/`world.update`, no update object).
    private cNames: string[][] = [];
    private cSchemas: Record<string, any>[] = [];
    private cArrays: Record<string, any>[] = [];

    // Reused scratch for the dirty-entity union (no Set, no array churn).
    private seen = new Uint8Array(0);
    private dirtyEids = new Uint32Array(0);
    private dirtyCount = 0;

    constructor(opts: LagCompensationOptions) {
        this.name = opts.name ?? 'lag-compensation';
        this.historyMs = opts.historyMs ?? 500;
        this.tickRate = opts.tickRate;
        this.components = opts.components;
        this.ringSize = Math.ceil((this.historyMs / 1000) * this.tickRate) + 1;
    }

    onMount(server: any): void {
        const world: World = server.world;
        this.world = world;

        for (const c of this.components) {
            if (c.__worldIndex === undefined) {
                throw new Error(
                    `LagCompensation: component "${c.name}" is not registered in the world.`,
                );
            }
        }

        this.words = maskWords(this.components.length);
        let fieldBytes = 0;
        for (const c of this.components) {
            fieldBytes += c.size;
            this.cNames.push(c.fieldNames as string[]);
            this.cSchemas.push(c.schema as Record<string, any>);
            this.cArrays.push(world.fields(c) as Record<string, any>);
        }
        this.entryStride = 4 + this.words * 4 + fieldBytes;

        const maxEntities = world.getMaxEntities();
        this.seen = new Uint8Array(maxEntities);
        this.dirtyEids = new Uint32Array(maxEntities);

        const initial = HEADER_BYTES + Math.min(maxEntities, INITIAL_ENTITIES) * this.entryStride;
        for (let i = 0; i < this.ringSize; i++) this.frames.push(makeFrame(initial));
        this.ensureScratch(initial);
    }

    onTick(_world: World, _dt: number): void {
        const world = this.world;
        if (world === null) return;
        this.currentTick++;

        // Union of entities dirty for any configured component.
        this.collectDirty(world);
        // Dirty tracking can be empty when a component is written outside the
        // tracked paths; fall back to recording everything, as before.
        if (this.dirtyCount === 0) this.collectAll(world);

        const count = this.dirtyCount;
        const frame = this.frames[this.ringHead];
        this.ensureFrame(frame, count);
        frame.tick = this.currentTick;
        const dv = frame.dv;
        dv.setUint32(0, this.currentTick, true);

        let off = HEADER_BYTES;
        let written = 0;
        for (let i = 0; i < count; i++) {
            const e = this.dirtyEids[i];
            dv.setUint32(off, e, true);
            off += 4;
            off = world.writeEntity(e, this.components, dv, off);
            written++;
        }
        dv.setUint32(4, written, true);

        this.ringHead = (this.ringHead + 1) % this.ringSize;
    }

    rewind<T>(clientTick: number, fn: () => T): T {
        const world = this.world;
        if (world === null) return fn();

        const index = this.findFrame(clientTick);
        if (index === -1) return fn();

        const frame = this.frames[index];
        const count = frame.dv.getUint32(4, true);
        if (count === 0) return fn();

        this.ensureScratch(HEADER_BYTES + count * this.entryStride);
        const sdv = this.scratchDv;

        // Save current state and apply the historical state in one pass.
        let foff = HEADER_BYTES;
        let soff = HEADER_BYTES;
        let saved = 0;
        for (let i = 0; i < count; i++) {
            const e = frame.dv.getUint32(foff, true);
            foff += 4;
            if (world.isAlive(e)) {
                sdv.setUint32(soff, e, true);
                soff += 4;
                soff = world.writeEntity(e, this.components, sdv, soff);
                saved++;
                foff = this.readEntity(world, e, frame.dv, foff);
            } else {
                foff = this.skipEntity(frame.dv, foff);
            }
        }
        sdv.setUint32(4, saved, true);

        try {
            return fn();
        } finally {
            let roff = HEADER_BYTES;
            for (let i = 0; i < saved; i++) {
                const e = sdv.getUint32(roff, true);
                roff += 4;
                if (world.isAlive(e)) {
                    roff = this.readEntity(world, e, sdv, roff);
                } else {
                    roff = this.skipEntity(sdv, roff);
                }
            }
        }
    }

    // ——— internals ———

    private collectDirty(world: World): void {
        this.dirtyCount = 0;
        for (let i = 0; i < this.components.length; i++) {
            world.forEachDirty(this.components[i], this.addDirty);
        }
        for (let i = 0; i < this.dirtyCount; i++) this.seen[this.dirtyEids[i]] = 0;
    }

    private collectAll(world: World): void {
        this.dirtyCount = 0;
        for (let i = 0; i < this.components.length; i++) {
            const ids = world.query(this.components[i]);
            for (let j = 0; j < ids.length; j++) this.addDirty(ids[j]);
        }
        for (let i = 0; i < this.dirtyCount; i++) this.seen[this.dirtyEids[i]] = 0;
    }

    private readonly addDirty = (eid: Entity): void => {
        if (this.seen[eid]) return;
        this.seen[eid] = 1;
        this.dirtyEids[this.dirtyCount++] = eid;
    };

    private findFrame(clientTick: number): number {
        const delta = this.currentTick - clientTick;
        if (delta >= 0 && delta < this.ringSize) {
            const idx = (this.ringHead - 1 - delta + this.ringSize) % this.ringSize;
            if (this.frames[idx].tick === clientTick) return idx;
        }
        // Gap/out-of-range: nearest retained frame.
        let best = -1;
        let bestDelta = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < this.ringSize; i++) {
            const t = this.frames[i].tick;
            if (t < 0) continue;
            const d = Math.abs(t - clientTick);
            if (d < bestDelta) {
                bestDelta = d;
                best = i;
            }
        }
        return best;
    }

    private ensureFrame(frame: Frame, count: number): void {
        const required = HEADER_BYTES + count * this.entryStride;
        if (frame.bytes.length >= required) return;
        frame.bytes = new Uint8Array(required);
        frame.dv = new DataView(frame.bytes.buffer);
    }

    private ensureScratch(required: number): void {
        if (this.scratch.length >= required) return;
        this.scratch = new Uint8Array(required);
        this.scratchDv = new DataView(this.scratch.buffer);
    }

    /**
     * Overlay one entity entry from `dv` onto the world's SoA arrays.
     * Zero-allocation: reads straight into the field typed arrays and marks
     * each touched component dirty, rather than building an update object and
     * routing through `world.update`.
     */
    private readEntity(world: World, eid: Entity, dv: DataView, off: number): number {
        const comps = this.components;
        const words = this.words;
        let o = off + words * 4;
        for (let w = 0; w < words; w++) {
            const word = dv.getUint32(off + w * 4, true);
            const base = w * 32;
            const end = Math.min(base + 32, comps.length);
            for (let ci = base; ci < end; ci++) {
                const c = comps[ci];
                const names = this.cNames[ci];
                const schema = this.cSchemas[ci];
                if ((word & (1 << (ci - base))) === 0) continue;
                if (world.has(eid, c)) {
                    const arrays = this.cArrays[ci];
                    for (let fi = 0; fi < names.length; fi++) {
                        const fn = names[fi];
                        arrays[fn][eid] = schema[fn].read(dv, o);
                        o += schema[fn].size;
                    }
                    world.markDirty(eid, c.__worldIndex!);
                } else {
                    for (let fi = 0; fi < names.length; fi++) o += schema[names[fi]].size;
                }
            }
        }
        return o;
    }

    /** Advance past an entity entry without writing it (despawned entity). */
    private skipEntity(dv: DataView, off: number): number {
        const comps = this.components;
        const words = this.words;
        let o = off + words * 4;
        for (let w = 0; w < words; w++) {
            const word = dv.getUint32(off + w * 4, true);
            const base = w * 32;
            const end = Math.min(base + 32, comps.length);
            for (let ci = base; ci < end; ci++) {
                if ((word & (1 << (ci - base))) !== 0) o += comps[ci].size;
            }
        }
        return o;
    }
}

function makeFrame(size: number): Frame {
    const bytes = new Uint8Array(size);
    return { tick: -1, bytes, dv: new DataView(bytes.buffer) };
}

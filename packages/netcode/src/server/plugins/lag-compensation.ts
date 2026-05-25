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

interface HistoryFrame {
    tick: number;
    /** componentIndex -> Map<entity, snapshot> */
    snapshots: Map<number, any>[];
}

/**
 * Records the configured components every tick for `historyMs` worth of
 * frames. `rewind(clientTick, fn)` overlays the historical state for the
 * duration of `fn`, then restores. Used inside server-only handlers for
 * hit detection that's fair across players with different pings.
 */
export class LagCompensation implements ServerPlugin {
    readonly name: string;
    readonly historyMs: number;
    readonly tickRate: number;
    private components: Component<any>[];
    private componentIndices: number[] = [];
    private ringBuffer: HistoryFrame[] = [];
    private ringSize: number;
    private ringHead = 0;
    private currentTick = 0;
    private world: World | null = null;

    constructor(opts: LagCompensationOptions) {
        this.name = opts.name ?? 'lag-compensation';
        this.historyMs = opts.historyMs ?? 500;
        this.tickRate = opts.tickRate;
        this.components = opts.components;
        this.ringSize = Math.ceil((this.historyMs / 1000) * this.tickRate) + 1;

        for (let i = 0; i < this.ringSize; i++) {
            this.ringBuffer.push({ tick: -1, snapshots: [] });
        }
    }

    onMount(server: any): void {
        this.world = server.world;
        for (const c of this.components) {
            if (c.__worldIndex === undefined) {
                throw new Error(
                    `LagCompensation: component "${c.name}" is not registered in the world.`,
                );
            }
            this.componentIndices.push(c.__worldIndex);
        }
    }

    onTick(_world: World, _dt: number): void {
        const world = this.world;
        if (world === null) return;
        this.currentTick++;
        const frame = this.ringBuffer[this.ringHead];
        frame.tick = this.currentTick;
        frame.snapshots = [];
        for (let i = 0; i < this.components.length; i++) {
            const c = this.components[i];
            const snap = new Map<Entity, any>();
            world.forEachDirty(c, (eid) => {
                snap.set(eid, { ...world.get(eid, c) });
            });
            // Fallback if dirty tracking is empty (e.g. unsynced component):
            // snapshot every entity that has it.
            if (snap.size === 0) {
                for (const eid of world.query(c)) {
                    snap.set(eid, { ...world.get(eid, c) });
                }
            }
            frame.snapshots[i] = snap;
        }
        this.ringHead = (this.ringHead + 1) % this.ringSize;
    }

    rewind<T>(clientTick: number, fn: () => T): T {
        const world = this.world;
        if (world === null) return fn();

        let chosen: HistoryFrame | null = null;
        let bestDelta = Number.MAX_SAFE_INTEGER;
        for (const frame of this.ringBuffer) {
            if (frame.tick < 0) continue;
            const d = Math.abs(frame.tick - clientTick);
            if (d < bestDelta) {
                bestDelta = d;
                chosen = frame;
            }
        }
        if (chosen === null) return fn();

        const saved: Map<Entity, any>[] = [];
        for (let i = 0; i < this.components.length; i++) {
            const c = this.components[i];
            const snap = chosen.snapshots[i];
            if (!snap) {
                saved[i] = new Map();
                continue;
            }
            const savedFrame = new Map<Entity, any>();
            for (const [eid, value] of snap) {
                if (world.has(eid, c)) {
                    savedFrame.set(eid, { ...world.get(eid, c) });
                    world.set(eid, c, value as any);
                }
            }
            saved[i] = savedFrame;
        }

        try {
            return fn();
        } finally {
            for (let i = 0; i < this.components.length; i++) {
                const c = this.components[i];
                const savedFrame = saved[i];
                for (const [eid, value] of savedFrame) {
                    if (world.has(eid, c)) world.set(eid, c, value as any);
                }
            }
        }
    }
}

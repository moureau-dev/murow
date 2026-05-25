import { lerp } from 'murow/core/lerp';
import type { Component, Entity, World } from 'murow/ecs';
import type { SyncSpec, InterpolationMode } from '../components/sync-spec';

export interface BufferedSnapshot {
    receivedAt: number;
    serverTick: number;
    entityIds: number[];
    componentValuesByEntity: Map<number, Map<Component<any>, Record<string, number>>>;
}

function modeFor(c: Component<any>): InterpolationMode {
    const sync = c.__sync as SyncSpec | undefined;
    return sync?.interp ?? 'lerp';
}

/**
 * Holds the last few snapshots and writes a fixed-cadence value into World
 * each tick. With `delayMs > 0`, renders `delayMs` behind the newest snapshot,
 * lerping between the two snapshots straddling that past time. With
 * `delayMs == 0`, emits the newest snapshot.
 *
 * Predicted entities are skipped: reconciliation drives them.
 */
export class InterpolationBuffer {
    private serverToLocal: Map<number, Entity>;
    private buffer: BufferedSnapshot[] = [];
    private capacity: number;
    private delayMs: number;
    /**
     * Max gap (ms) between consecutive snapshots before existing history
     * is dropped. Past this gap, lerping across the gap would walk the
     * peer slowly through stale territory.
     */
    private staleWindowMs: number;

    constructor(
        serverToLocal: Map<number, Entity>,
        capacity: number,
        delayMs: number,
        staleWindowMs: number,
    ) {
        this.serverToLocal = serverToLocal;
        this.capacity = capacity;
        this.delayMs = delayMs;
        this.staleWindowMs = staleWindowMs;
    }

    setDelay(delayMs: number): void {
        this.delayMs = delayMs;
    }

    setStaleWindow(staleWindowMs: number): void {
        this.staleWindowMs = staleWindowMs;
    }

    record(snapshot: BufferedSnapshot): void {
        const last = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
        if (last !== null) {
            const gap = snapshot.receivedAt - last.receivedAt;
            if (gap > this.staleWindowMs) {
                this.buffer.length = 0;
            }
        }
        this.buffer.push(snapshot);
        while (this.buffer.length > this.capacity) this.buffer.shift();
    }

    forget(_serverEid: number): void {
        // Snapshots arrive whole; despawned entities just stop appearing.
    }

    clear(): void {
        this.buffer.length = 0;
    }

    apply(
        world: World,
        now: number,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void {
        if (this.buffer.length === 0) return;

        const renderTime = now - this.delayMs;

        let a: BufferedSnapshot | null = null;
        let b: BufferedSnapshot | null = null;
        for (let i = 0; i < this.buffer.length - 1; i++) {
            const s0 = this.buffer[i];
            const s1 = this.buffer[i + 1];
            if (s0.receivedAt <= renderTime && renderTime <= s1.receivedAt) {
                a = s0;
                b = s1;
                break;
            }
        }

        if (a === null || b === null) {
            const head = this.buffer[this.buffer.length - 1];

            if (renderTime < this.buffer[0].receivedAt) {
                // Underrun: respect the interpolation delay by holding
                // whatever World last had (archetype init or previous
                // lerp). The peer stays put until the delay elapses.
                return;
            }

            // Overrun: past the newest. Use it.
            this.writeSnapshot(world, head, components, shouldSkip);
            return;
        }

        const span = b.receivedAt - a.receivedAt;
        const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.receivedAt) / span)) : 0;

        const seen = new Set<number>();
        for (const eid of a.entityIds) seen.add(eid);
        for (const eid of b.entityIds) seen.add(eid);

        for (const serverEid of seen) {
            const localEid = this.serverToLocal.get(serverEid);
            if (localEid === undefined) continue;
            if (shouldSkip(localEid)) continue;

            const compsA = a.componentValuesByEntity.get(serverEid);
            const compsB = b.componentValuesByEntity.get(serverEid);

            for (const c of components) {
                const va = compsA?.get(c);
                const vb = compsB?.get(c);
                if (va === undefined && vb === undefined) continue;

                let toWrite: Record<string, any> | undefined;

                if (vb === undefined) {
                    toWrite = va;
                } else if (va === undefined) {
                    toWrite = vb;
                } else {
                    const mode = modeFor(c);
                    if (mode === 'none') {
                        toWrite = vb;
                    } else if (mode === 'step') {
                        toWrite = t < 0.5 ? va : vb;
                    } else {
                        // slerp falls through to lerp until implemented.
                        const out: Record<string, number> = {};
                        for (const fieldName of c.fieldNames as string[]) {
                            out[fieldName] = lerp(
                                va[fieldName] as number,
                                vb[fieldName] as number,
                                t,
                            );
                        }
                        toWrite = out;
                    }
                }

                if (toWrite === undefined) continue;
                if (world.has(localEid, c)) {
                    world.update(localEid, c, toWrite as any);
                } else {
                    world.add(localEid, c, toWrite as any);
                }
            }
        }
    }

    private writeSnapshot(
        world: World,
        snap: BufferedSnapshot,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void {
        for (const serverEid of snap.entityIds) {
            const localEid = this.serverToLocal.get(serverEid);
            if (localEid === undefined) continue;
            if (shouldSkip(localEid)) continue;
            const comps = snap.componentValuesByEntity.get(serverEid);
            if (comps === undefined) continue;
            for (const c of components) {
                const v = comps.get(c);
                if (v === undefined) continue;
                if (world.has(localEid, c)) world.update(localEid, c, v as any);
                else world.add(localEid, c, v as any);
            }
        }
    }
}

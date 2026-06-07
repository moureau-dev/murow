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

/** Desync past which the play-out clock hard-snaps instead of warping. */
const DEFAULT_MAX_DESYNC = 500;

/** Drift under this (ticks) advances at nominal rate, so a synced clock holds steady. */
const WARP_DEAD_ZONE = 0.25;

/** Largest data gap (ms) the buffer interpolates across; bigger gaps hold the last value. */
const DEFAULT_MAX_BRIDGE_GAP = 250;

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
    private renderTick = -Infinity;
    private latestReceivedAt = -Infinity;
    private smoothedTickRateMs = 0;
    delay: number;
    /**
     * Max gap (ms) between consecutive snapshots before existing history
     * is dropped. Past this gap, lerping across the gap would walk the
     * peer slowly through stale territory.
     */
    staleWindow: number;
    /** Desync past which the play-out clock snaps instead of warping, ms. */
    maxDesync: number;
    /** Known wall-ms per server tick, used to seed the rate estimate. 0 to infer. */
    private nominalTickMs: number;
    /** Largest data gap the buffer interpolates across, ms. Bigger gaps hold. */
    maxBridgeGap: number;

    constructor(
        serverToLocal: Map<number, Entity>,
        capacity: number,
        delayMs: number,
        staleWindowMs: number,
        maxDesyncMs: number = DEFAULT_MAX_DESYNC,
        nominalTickMs: number = 0,
        maxBridgeGapMs: number = DEFAULT_MAX_BRIDGE_GAP,
    ) {
        this.serverToLocal = serverToLocal;
        this.capacity = capacity;
        this.delay = delayMs;
        this.staleWindow = staleWindowMs;
        this.maxDesync = maxDesyncMs;
        this.nominalTickMs = nominalTickMs;
        this.smoothedTickRateMs = nominalTickMs;
        this.maxBridgeGap = maxBridgeGapMs;
    }

    setDelay(delayMs: number): void {
        this.delay = delayMs;
    }

    setStaleWindow(staleWindowMs: number): void {
        this.staleWindow = staleWindowMs;
    }

    setMaxDesync(maxDesyncMs: number): void {
        this.maxDesync = maxDesyncMs;
    }

    setMaxBridgeGap(maxBridgeGapMs: number): void {
        this.maxBridgeGap = maxBridgeGapMs;
    }

    record(snapshot: BufferedSnapshot): void {
        const gap = snapshot.receivedAt - this.latestReceivedAt;
        if (this.buffer.length > 0 && gap > this.staleWindow) {
            this.buffer.length = 0;
            this.renderTick = -Infinity;
            this.latestReceivedAt = -Infinity;
            this.smoothedTickRateMs = this.nominalTickMs;
        }
        if (snapshot.receivedAt > this.latestReceivedAt) {
            this.latestReceivedAt = snapshot.receivedAt;
        }

        let insertAt = this.buffer.length;
        while (insertAt > 0 && this.buffer[insertAt - 1].serverTick >= snapshot.serverTick) {
            if (this.buffer[insertAt - 1].serverTick === snapshot.serverTick) return;
            insertAt--;
        }
        this.buffer.splice(insertAt, 0, snapshot);

        while (this.buffer.length > this.capacity) this.buffer.shift();
    }

    clear(): void {
        this.buffer.length = 0;
        this.renderTick = -Infinity;
        this.latestReceivedAt = -Infinity;
        this.smoothedTickRateMs = this.nominalTickMs;
    }

    apply(
        world: World,
        now: number,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void {
        if (this.buffer.length === 0) return;

        const newest = this.buffer[this.buffer.length - 1];
        const oldest = this.buffer[0];

        let tickRateMs: number = 0;
        if (this.buffer.length >= 2) {
            const tickSpan = newest.serverTick - oldest.serverTick;
            const wallSpan = this.latestReceivedAt - oldest.receivedAt;
            const rawTickRateMs = tickSpan > 0 && wallSpan > 0 ? wallSpan / tickSpan : 0;
            if (rawTickRateMs > 0) {
                if (this.smoothedTickRateMs === 0) this.smoothedTickRateMs = rawTickRateMs;
                else this.smoothedTickRateMs = this.smoothedTickRateMs * 0.9 + rawTickRateMs * 0.1;
            }

            tickRateMs = this.smoothedTickRateMs;
        }

        if (tickRateMs === 0) {
            if (now - newest.receivedAt < this.delay) return;
            this.writeSnapshot(world, newest, components, shouldSkip);
            return;
        }

        const ageBeyondDelay = now - newest.receivedAt - this.delay;
        const targetTick = newest.serverTick + ageBeyondDelay / tickRateMs;

        if (this.renderTick === -Infinity) {
            this.renderTick = targetTick;
        } else {
            const drift = targetTick - this.renderTick;
            if (drift > this.maxDesync / tickRateMs) {
                this.renderTick = targetTick;
            } else if (Math.abs(drift) < WARP_DEAD_ZONE) {
                this.renderTick += 1;
            } else {
                const warp = Math.max(0.6, Math.min(1.4, 1 + drift * 0.1));
                this.renderTick += warp;
            }
        }

        const renderTick = this.renderTick;

        let a: BufferedSnapshot | null = null;
        let b: BufferedSnapshot | null = null;
        for (let i = 0; i < this.buffer.length - 1; i++) {
            const s0 = this.buffer[i];
            const s1 = this.buffer[i + 1];
            if (s0.serverTick <= renderTick && renderTick <= s1.serverTick) {
                a = s0;
                b = s1;
                break;
            }
        }

        if (a === null || b === null) {
            if (renderTick < oldest.serverTick) return;
            this.writeSnapshot(world, newest, components, shouldSkip);
            return;
        }

        const seen = new Set<number>();
        for (const eid of a.entityIds) seen.add(eid);
        for (const eid of b.entityIds) seen.add(eid);

        const aIndex = this.buffer.indexOf(a);
        const bIndex = this.buffer.indexOf(b);

        // Beyond this many ticks ahead, a missing value is a starved entity
        // (idle), not a transient hole, so hold rather than reach across it.
        const maxBridgeTicks = this.maxBridgeGap / tickRateMs;

        for (const serverEid of seen) {
            const localEid = this.serverToLocal.get(serverEid);
            if (localEid === undefined) continue;
            if (shouldSkip(localEid)) continue;

            for (const c of components) {
                let aIdx = aIndex;
                let va = a.componentValuesByEntity.get(serverEid)?.get(c);
                while (va === undefined && aIdx > 0) {
                    aIdx--;
                    va = this.buffer[aIdx].componentValuesByEntity.get(serverEid)?.get(c);
                }

                let bIdx = bIndex;
                let vb = b.componentValuesByEntity.get(serverEid)?.get(c);
                while (vb === undefined && bIdx < this.buffer.length - 1) {
                    bIdx++;
                    vb = this.buffer[bIdx].componentValuesByEntity.get(serverEid)?.get(c);
                }

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
                    } else {
                        const bTick = this.buffer[bIdx].serverTick;
                        let aTick = this.buffer[aIdx].serverTick;
                        // Samples straddling a gap bigger than the bridge limit mean
                        // the entity was starved (idle). Hold the last value until one
                        // tick before it reappears, then ramp in over that single tick.
                        if (bTick - aTick > maxBridgeTicks) aTick = bTick - 1;
                        const wideSpan = bTick - aTick;
                        const wideT = wideSpan > 0
                            ? Math.min(1, Math.max(0, (renderTick - aTick) / wideSpan))
                            : 0;
                        if (mode === 'step') {
                            toWrite = wideT < 0.5 ? va : vb;
                        } else {
                            // slerp falls through to lerp until implemented.
                            const out: Record<string, number> = {};
                            for (const fieldName of c.fieldNames as string[]) {
                                out[fieldName] = lerp(
                                    va[fieldName] as number,
                                    vb[fieldName] as number,
                                    wideT,
                                );
                            }
                            toWrite = out;
                        }
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

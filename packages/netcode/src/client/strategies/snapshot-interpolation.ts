import { lerp } from 'murow/core/lerp';
import { Timeline } from 'murow/core/timeline';
import { SlewClock } from 'murow/core/clock';
import type { Component, Entity, World } from 'murow/ecs';
import type { SyncSpec, InterpolationMode } from '../../components/sync-spec';

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
 * The four field names holding a quaternion, if this component looks like one:
 * `x`/`y`/`z`/`w` by name, or exactly four fields in declaration order. `null`
 * for anything else (slerp then falls back to lerp).
 */
function quaternionFields(c: Component<any>): [string, string, string, string] | null {
    const names = c.fieldNames as string[];
    const byName = ['x', 'y', 'z', 'w'];
    if (byName.every((n) => names.includes(n))) return ['x', 'y', 'z', 'w'];
    if (names.length === 4) return [names[0], names[1], names[2], names[3]];
    return null;
}

/** Shortest-arc spherical interpolation of two unit quaternions (x,y,z,w). */
function slerpQuat(a: number[], b: number[], t: number): number[] {
    let [bx, by, bz, bw] = b;
    let dot = a[0]! * bx + a[1]! * by + a[2]! * bz + a[3]! * bw;
    if (dot < 0) {
        bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot;
    }
    if (dot > 0.9995) {
        // Nearly parallel: lerp then renormalize.
        const x = lerp(a[0]!, bx, t), y = lerp(a[1]!, by, t), z = lerp(a[2]!, bz, t), w = lerp(a[3]!, bw, t);
        const inv = 1 / (Math.hypot(x, y, z, w) || 1);
        return [x * inv, y * inv, z * inv, w * inv];
    }
    const theta0 = Math.acos(dot);
    const theta = theta0 * t;
    const sinTheta = Math.sin(theta);
    const sinTheta0 = Math.sin(theta0);
    const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
    const s1 = sinTheta / sinTheta0;
    return [s0 * a[0]! + s1 * bx, s0 * a[1]! + s1 * by, s0 * a[2]! + s1 * bz, s0 * a[3]! + s1 * bw];
}

/** Desync past which the play-out clock hard-snaps instead of warping. */
const DEFAULT_MAX_DESYNC = 500;

/** Largest data gap (ms) the buffer interpolates across; bigger gaps hold the last value. */
const DEFAULT_MAX_BRIDGE_GAP = 250;

/**
 * Snapshot-interpolation strategy: renders peer entities `delay` ms behind the
 * newest snapshot, lerping between the two snapshots straddling that past time.
 * Composes a core `Timeline` (snapshot history) and a core `SlewClock`
 * (play-out clock). Predicted entities are skipped; reconciliation drives them.
 */
export class SnapshotInterpolation {
    private serverToLocal: Map<number, Entity>;
    private timeline: Timeline<BufferedSnapshot>;
    private clock = new SlewClock();
    private smoothedTickRateMs: number;
    private readonly seenScratch = new Set<number>();
    private nominalTickMs: number;
    delay: number;
    maxDesync: number;
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
        this.timeline = new Timeline<BufferedSnapshot>(capacity, staleWindowMs);
        this.delay = delayMs;
        this.maxDesync = maxDesyncMs;
        this.nominalTickMs = nominalTickMs;
        this.smoothedTickRateMs = nominalTickMs;
        this.maxBridgeGap = maxBridgeGapMs;
    }

    get staleWindow(): number {
        return this.timeline.staleWindow;
    }

    setDelay(delayMs: number): void {
        this.delay = delayMs;
    }

    setStaleWindow(staleWindowMs: number): void {
        this.timeline.setStaleWindow(staleWindowMs);
    }

    setMaxDesync(maxDesyncMs: number): void {
        this.maxDesync = maxDesyncMs;
    }

    setMaxBridgeGap(maxBridgeGapMs: number): void {
        this.maxBridgeGap = maxBridgeGapMs;
    }

    record(snapshot: BufferedSnapshot): void {
        const reset = this.timeline.record(snapshot.serverTick, snapshot.receivedAt, snapshot);
        if (reset) {
            this.smoothedTickRateMs = this.nominalTickMs;
            this.clock.reset();
        }
    }

    clear(): void {
        this.timeline.clear();
        this.clock.reset();
        this.smoothedTickRateMs = this.nominalTickMs;
    }

    apply(
        world: World,
        now: number,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void {
        const tl = this.timeline;
        if (tl.length === 0) return;

        const newest = tl.newest()!.sample;
        const oldest = tl.oldest()!.sample;

        let tickRateMs = 0;
        if (tl.length >= 2) {
            const tickSpan = newest.serverTick - oldest.serverTick;
            const wallSpan = tl.latestReceivedAt - oldest.receivedAt;
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
        const renderTick = this.clock.advance(targetTick, this.maxDesync / tickRateMs);

        const straddle = tl.straddle(renderTick);
        if (straddle === null) {
            if (renderTick < oldest.serverTick) return;
            this.writeSnapshot(world, newest, components, shouldSkip);
            return;
        }
        const [aIndex, bIndex] = straddle;
        const a = tl.at(aIndex).sample;
        const b = tl.at(bIndex).sample;

        const seen = this.seenScratch;
        seen.clear();
        for (const eid of a.entityIds) seen.add(eid);
        for (const eid of b.entityIds) seen.add(eid);

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
                    va = tl.at(aIdx).sample.componentValuesByEntity.get(serverEid)?.get(c);
                }

                let bIdx = bIndex;
                let vb = b.componentValuesByEntity.get(serverEid)?.get(c);
                while (vb === undefined && bIdx < tl.length - 1) {
                    bIdx++;
                    vb = tl.at(bIdx).sample.componentValuesByEntity.get(serverEid)?.get(c);
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
                        const bTick = tl.at(bIdx).sample.serverTick;
                        let aTick = tl.at(aIdx).sample.serverTick;
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
                            const qf = mode === 'slerp' ? quaternionFields(c) : null;
                            const out: Record<string, number> = {};
                            if (qf) {
                                const q = slerpQuat(
                                    [va[qf[0]] as number, va[qf[1]] as number, va[qf[2]] as number, va[qf[3]] as number],
                                    [vb[qf[0]] as number, vb[qf[1]] as number, vb[qf[2]] as number, vb[qf[3]] as number],
                                    wideT,
                                );
                                for (const fieldName of c.fieldNames as string[]) {
                                    const qi = qf.indexOf(fieldName);
                                    out[fieldName] = qi === -1
                                        ? lerp(va[fieldName] as number, vb[fieldName] as number, wideT)
                                        : q[qi]!;
                                }
                            } else {
                                for (const fieldName of c.fieldNames as string[]) {
                                    out[fieldName] = lerp(
                                        va[fieldName] as number,
                                        vb[fieldName] as number,
                                        wideT,
                                    );
                                }
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

import type { Component, Entity, World } from 'murow/ecs';
import { SnapshotInterpolationStrategy } from '../interpolation';
import { applyExtrapolation } from '../extrapolation';
import { PeerRenderStrategy } from '../strategy';
import type { PeerRenderContext } from '../strategy';
import type { BufferedSnapshot } from '../interpolation';

export interface HybridOptions {
    /** Interpolation delay, ms. Default 100. */
    delay?: number;
    /** Max ms to project past the newest snapshot when starved. Default 200. */
    maxExtrapolationMs?: number;
    /** Max ms between snapshots before history is dropped. Default `delay * 2 + 100`. */
    staleWindow?: number;
    /** Desync past which the play-out clock hard-snaps, ms. Default 500. */
    maxDesync?: number;
    /** Largest data gap held instead of bridged, ms. Default 250. */
    maxBridgeGap?: number;
    /** Snapshot ring capacity. Defaults to the context capacity. */
    capacity?: number;
}

/**
 * Interpolation with an extrapolation cap: interpolates peers `delay` ms behind
 * newest while snapshots keep arriving, and — when the newest snapshot goes
 * older than `delay` (starved under loss / a stalled server) — projects each
 * peer forward from its last velocity for up to `maxExtrapolationMs`, then
 * holds. The two regimes meet continuously at the starvation boundary.
 *
 * This is the production default most engines use: smooth like interpolation,
 * but without freezing when data stops. One strategy instance per client.
 */
export class HybridStrategy extends PeerRenderStrategy {
    private readonly interp: SnapshotInterpolationStrategy;
    private readonly maxExtrapolationMs: number;
    private newest: BufferedSnapshot | null = null;
    private prev: BufferedSnapshot | null = null;
    private serverToLocal: Map<number, Entity> = new Map();
    private readonly scratch: Record<string, number> = {};

    constructor(options: HybridOptions = {}) {
        super();
        this.delay = options.delay ?? 100;
        this.maxExtrapolationMs = options.maxExtrapolationMs ?? 200;
        this.interp = new SnapshotInterpolationStrategy({
            delay: options.delay,
            staleWindow: options.staleWindow,
            maxDesync: options.maxDesync,
            maxBridgeGap: options.maxBridgeGap,
            capacity: options.capacity,
        });
    }

    protected override onBind(ctx: PeerRenderContext): void {
        this.serverToLocal = ctx.serverToLocal;
        this.interp.bind(ctx);
    }

    record(snapshot: BufferedSnapshot): void {
        this.interp.record(snapshot);
        if (this.newest === null || snapshot.serverTick >= this.newest.serverTick) {
            this.prev = this.newest;
            this.newest = snapshot;
        } else if (this.prev === null || snapshot.serverTick > this.prev.serverTick) {
            this.prev = snapshot;
        }
    }

    clear(): void {
        this.interp.clear();
        this.newest = null;
        this.prev = null;
    }

    apply(
        world: World,
        now: number,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void {
        const newest = this.newest;
        if (newest === null) return;

        // Render at `now - delay`; while a snapshot still lies ahead of that,
        // interpolate. Once the newest is older than `delay`, project forward.
        const starveAge = now - newest.receivedAt - this.delay;
        if (starveAge <= 0) {
            this.interp.apply(world, now, components, shouldSkip);
            return;
        }
        const elapsed = Math.min(starveAge, this.maxExtrapolationMs);
        applyExtrapolation(world, newest, this.prev, elapsed, this.scratch, components, shouldSkip, this.serverToLocal);
    }

    override setDelay(ms: number): void {
        this.delay = ms;
        this.interp.setDelay(ms);
    }
    override setMaxDesync(ms: number): void {
        this.interp.setMaxDesync(ms);
    }
    override setMaxBridgeGap(ms: number): void {
        this.interp.setMaxBridgeGap(ms);
    }
    override setStaleWindow(ms: number): void {
        this.interp.setStaleWindow(ms);
    }
}

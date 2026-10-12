import type { Component, Entity, World } from 'murow/ecs';
import { Timeline } from 'murow/core/timeline';
import { PeerRenderStrategy } from '../strategy';
import type { PeerRenderContext } from '../strategy';
import type { BufferedSnapshot } from '../interpolation';

export interface ExtrapolationOptions {
    /**
     * Max ms to project a peer past its newest snapshot before holding. Bounds
     * how far a wrong projection can run. Default 200.
     */
    maxExtrapolationMs?: number;
    /** Snapshot ring capacity. Defaults to the context capacity. */
    capacity?: number;
}

/**
 * Project every entity in `newest` forward by `elapsedMs`, using the velocity
 * between `prev` and `newest` (held when there is no `prev`). `scratch` is a
 * reused object so the hot path allocates nothing.
 */
export function applyExtrapolation(
    world: World,
    newest: BufferedSnapshot,
    prev: BufferedSnapshot | null,
    elapsedMs: number,
    scratch: Record<string, number>,
    components: Component<any>[],
    shouldSkip: (entity: Entity) => boolean,
    serverToLocal: Map<number, Entity>,
): void {
    const dtMs = prev !== null ? newest.receivedAt - prev.receivedAt : 0;
    const k = dtMs > 0 && elapsedMs > 0 ? elapsedMs / dtMs : 0;

    for (const serverEid of newest.entityIds) {
        const localEid = serverToLocal.get(serverEid);
        if (localEid === undefined || shouldSkip(localEid)) continue;
        const comps = newest.componentValuesByEntity.get(serverEid);
        if (comps === undefined) continue;

        for (const c of components) {
            const v = comps.get(c);
            if (v === undefined) continue;

            let toWrite: Record<string, number> = v;
            const vp = prev?.componentValuesByEntity.get(serverEid)?.get(c);
            if (vp !== undefined && k > 0) {
                const out = scratch;
                for (const fieldName of c.fieldNames as string[]) {
                    const cur = v[fieldName] as number;
                    out[fieldName] = cur + (cur - (vp[fieldName] as number)) * k;
                }
                toWrite = out;
            }

            if (world.has(localEid, c)) world.update(localEid, c, toWrite as any);
            else world.add(localEid, c, toWrite as any);
        }
    }
}

/**
 * Dead-reckoning peer-render strategy: renders at `now`, projecting each peer
 * forward from its last network velocity (derived from the two newest
 * snapshots) for up to `maxExtrapolationMs`. Falls back to holding the newest
 * value when velocity is unknown (`< 2` snapshots) or the cap is reached.
 *
 * Lower felt latency than interpolation, at the cost of visible correction
 * when a peer changes direction. Prefer interpolation for MOBAs/action-RPGs;
 * this suits fast movers under loss/high RTT.
 */
export class ExtrapolationStrategy extends PeerRenderStrategy {
    private timeline: Timeline<BufferedSnapshot> | null = null;
    private serverToLocal: Map<number, Entity> = new Map();
    private maxExtrapolationMs = 200;
    private readonly scratch: Record<string, number> = {};

    constructor(private readonly options: ExtrapolationOptions = {}) {
        super();
    }

    protected override onBind(ctx: PeerRenderContext): void {
        this.serverToLocal = ctx.serverToLocal;
        this.timeline = new Timeline<BufferedSnapshot>(this.options.capacity ?? ctx.capacity, 2000);
        this.maxExtrapolationMs = this.options.maxExtrapolationMs ?? 200;
    }

    record(snapshot: BufferedSnapshot): void {
        this.timeline?.record(snapshot.serverTick, snapshot.receivedAt, snapshot);
    }

    clear(): void {
        this.timeline?.clear();
    }

    apply(
        world: World,
        now: number,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void {
        const tl = this.timeline;
        if (tl === null || tl.length === 0) return;

        const newestIdx = tl.length - 1;
        const newest = tl.at(newestIdx).sample;
        const prev = newestIdx > 0 ? tl.at(newestIdx - 1).sample : null;
        const elapsed = Math.max(0, Math.min(now - newest.receivedAt, this.maxExtrapolationMs));

        applyExtrapolation(world, newest, prev, elapsed, this.scratch, components, shouldSkip, this.serverToLocal);
    }
}

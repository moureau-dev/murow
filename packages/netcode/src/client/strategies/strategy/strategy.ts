import type { Component, Entity, World } from 'murow/ecs';
import type { BufferedSnapshot } from '../interpolation';
import type { ServerEntityLookup } from '../../server-entity-map';
import type { SnapshotPool } from '../../../codec/snapshot-pool';

/**
 * Client context a peer-render strategy needs. `GameClient` builds it once and
 * hands it to `bind`, so a strategy can be constructed (with its own options)
 * before it knows the client.
 */
export interface PeerRenderContext {
    /** Server entity id -> local entity map owned by the client. */
    readonly serverToLocal: ServerEntityLookup;
    /** Wall clock in ms (`GameClient.now`). */
    readonly now: () => number;
    /** One simulation tick in ms. */
    readonly tickIntervalMs: number;
    /** Default snapshot ring capacity. */
    readonly capacity: number;
    /** Optional value pool the timeline recycles evicted snapshots into. */
    readonly snapshotPool?: SnapshotPool;
}

/**
 * How received snapshots become rendered peer state. Subclass and implement
 * the three abstract methods; the client drives the lifecycle:
 *
 * ```ts
 * const strategy = new SnapshotInterpolationStrategy({ delay: 100 });
 * new GameClient({ ...opts, strategy });
 * ```
 *
 * Local-player rendering is a separate axis (`prediction`), not a strategy.
 */
export abstract class PeerRenderStrategy {
    /** Injected by `GameClient` before first use. */
    protected ctx!: PeerRenderContext;
    /** Snapshot interpolation delay in ms; 0 for strategies without one. */
    delay = 0;

    /** Inject the client context. Called by `GameClient`; not public API. */
    bind(ctx: PeerRenderContext): void {
        this.ctx = ctx;
        this.onBind(ctx);
    }

    /** Hook for subclasses to build state once the context is known. */
    protected onBind(_ctx: PeerRenderContext): void {}

    /** Buffer a freshly received snapshot. */
    abstract record(snapshot: BufferedSnapshot): void;

    /** Write this tick's peer state into the world. */
    abstract apply(
        world: World,
        now: number,
        components: Component<any>[],
        shouldSkip: (entity: Entity) => boolean,
    ): void;

    /** Drop all buffered state. */
    abstract clear(): void;

    /** Tuners — no-ops unless a strategy overrides them. */
    setDelay(_ms: number): void {}
    setMaxDesync(_ms: number): void {}
    setMaxBridgeGap(_ms: number): void {}
    setStaleWindow(_ms: number): void {}
}

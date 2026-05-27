import { SimpleRNG } from 'murow/core/simple-rng';
import type { Component, Entity, World } from 'murow/ecs';
import type { GameLoop } from 'murow/game';
import type { TransportAdapter } from 'murow/net';
import { Network } from '../network/base';
import { decodeDelta, type DecodedDelta } from '../codec/delta-codec';
import { InterpolationBuffer } from './interpolation-buffer';
import type { DefinedIntents, IntentPayload, IntentSchemaMap } from '../intents/define-intents';
import type { DefinedRpcs, RpcPayload, RpcSchemaMap } from '../rpcs/define-rpcs';
import type { DefinedPredictions } from '../predictions/define-predictions';
import { makeFieldsAccessor, makeMarkDirty, type PredictionContext } from '../ctx';

const MSG_SNAPSHOT = 0x80;
const MSG_RPC = 0x81;
const MSG_KICK = 0x82;
const MSG_ASSIGN_ENTITY = 0x84;
const CMSG_INTENT = 0x01;
const CMSG_RPC = 0x02;
const CMSG_KICK_ACK = 0x03;

interface PredictedIntent {
    tick: number;
    name: string;
    payload: any;
    entity: Entity;
    deltaTime: number;
}

/**
 * Snapshot interpolation strategy. The client holds the last few
 * snapshots and renders peer entities `delay` ms behind newest, lerping
 * between the two snapshots straddling that past time. This is the
 * Source-engine model and the right default for action games, MMOs,
 * MOBAs, and `.io` titles.
 */
export interface SnapshotInterpolationStrategy {
    kind: 'snapshot-interpolation';
    /** Snapshot interpolation delay, ms. Default 100. */
    delay?: number;
    /**
     * Max ms between snapshots before history is dropped as stale.
     * Defaults to `delay * 2 + 100`.
     */
    staleWindow?: number;
}

/**
 * How peer entities are rendered on the client. Local-player rendering
 * is driven by `prediction` (separate axis) and is independent of the
 * peer strategy.
 *
 * Today only `snapshot-interpolation` ships. Extrapolation and rollback
 * variants will slot in here without protocol changes.
 */
export type PeerRenderStrategy = SnapshotInterpolationStrategy;

export interface GameClientOptions<
    I extends IntentSchemaMap,
    R extends RpcSchemaMap,
> {
    world: World;
    loop: GameLoop<any>;
    transport: TransportAdapter;
    protocol: {
        intents: DefinedIntents<I>;
        rpcs: DefinedRpcs<R>;
    };
    /**
     * Peer-rendering strategy. Defaults to snapshot interpolation with
     * a 100 ms delay.
     */
    strategy?: PeerRenderStrategy;
    prediction?: {
        /** Max buffered unacked predictions kept for rollback. Default 64. */
        bufferSize?: number;
    };
}

export class GameClient<
    I extends IntentSchemaMap = IntentSchemaMap,
    R extends RpcSchemaMap = RpcSchemaMap,
> extends Network<'client', R> {
    readonly world: World;
    readonly loop: GameLoop<any>;
    readonly transport: TransportAdapter;
    readonly intents: DefinedIntents<I>;
    readonly rpcs: DefinedRpcs<R>;

    private predictionMap: DefinedPredictions<I>['map'] | null = null;
    private interpolationDelay: number;
    private predictionBufferSize: number;
    private predictionHistory: PredictedIntent[] = [];

    private localTick = 0;
    private lastServerTick = 0;

    private serverToLocal = new Map<number, Entity>();
    private syncedComponents: Component<any>[] = [];
    private syncedNumMaskWords = 1;
    private rng: SimpleRNG;
    private lastDt: number;
    private predictedEntities = new Set<Entity>();
    /** Set when MSG_ASSIGN_ENTITY lands before the matching spawn. */
    private pendingAssignedServerEid: number | null = null;
    /** Resolved local entity for the server's assignment. Default for sendIntent. */
    private _assignedEntity: Entity | null = null;
    private interpBuffer: InterpolationBuffer;

    /**
     * Local entity the server has assigned to this peer, or `null` if no
     * assignment has been received yet. `sendIntent` is a no-op (emits an
     * `'error'` event) until this is set.
     */
    get assignedEntity(): Entity | null {
        return this._assignedEntity;
    }

    constructor(opts: GameClientOptions<I, R>) {
        super([
            'connected',
            'disconnected',
            'kicked',
            'snapshot',
            'rpc',
            'spawn',
            'despawn',
            'reconciled',
            'assigned',
            'error',
        ]);
        this.world = opts.world;
        this.loop = opts.loop;
        this.transport = opts.transport;
        this.intents = opts.protocol.intents;
        this.rpcs = opts.protocol.rpcs;
        const strategy: PeerRenderStrategy = opts.strategy ?? { kind: 'snapshot-interpolation' };
        this.interpolationDelay = strategy.delay ?? 100;
        const staleWindowMs = strategy.staleWindow ?? this.interpolationDelay * 2 + 100;
        this.predictionBufferSize = opts.prediction?.bufferSize ?? 64;
        this.rng = new SimpleRNG(1);
        this.lastDt = opts.loop.ticker.intervalMs / 1000;

        // 16 slots covers ~800ms at 20Hz.
        this.interpBuffer = new InterpolationBuffer(
            this.serverToLocal,
            16,
            this.interpolationDelay,
            staleWindowMs,
        );

        this.discoverSyncedComponents();
        this.wireTransport();
        this.wireLoop();
    }

    private discoverSyncedComponents(): void {
        const all = (this.world as any).components as Component<any>[];
        for (const c of all) {
            if (c.__sync !== undefined) this.syncedComponents.push(c);
        }
        this.syncedNumMaskWords = Math.max(1, Math.ceil(this.syncedComponents.length / 32));
    }

    private wireTransport(): void {
        this.transport.onOpen?.(() => this.emit('connected', {}));
        this.transport.onMessage((data) => this.handleIncoming(data));
        this.transport.onClose(() => this.emit('disconnected', { reason: 'transport-closed' }));
        this.transport.onError?.((error: Error) => this.emit('error', { error, context: 'transport' }));
    }

    private wireLoop(): void {
        const events = this.loop.events as any;
        events.on('sync', () => {
            this.interpBuffer.apply(
                this.world,
                performance.now(),
                this.syncedComponents,
                (e) => this.predictedEntities.has(e),
            );
        });

        events.on('tick', ({ deltaTime }: any) => {
            this.localTick++;
            this.lastDt = deltaTime;
        });
    }

    private handleIncoming(data: Uint8Array): void {
        if (data.length === 0) return;
        const type = data[0];

        if (type === MSG_SNAPSHOT) {
            this.handleSnapshot(data.subarray(1));
            return;
        }
        if (type === MSG_RPC) {
            this.handleRpc(data.subarray(1));
            return;
        }
        if (type === MSG_KICK) {
            const reason = new TextDecoder().decode(data.subarray(1));
            this.emit('kicked', { reason });
            const ack = new Uint8Array([CMSG_KICK_ACK]);
            this.transport.send(ack);
            return;
        }
        if (type === MSG_ASSIGN_ENTITY) {
            if (data.length < 5) {
                this.emit('error', {
                    error: new Error('MSG_ASSIGN_ENTITY frame too short'),
                    context: 'handleIncoming',
                });
                return;
            }
            const view = new DataView(data.buffer, data.byteOffset + 1, 4);
            this.applyAssignment(view.getUint32(0, true));
            return;
        }
        this.emit('error', {
            error: new Error(`Unknown server message type 0x${type.toString(16)}`),
            context: 'handleIncoming',
        });
    }

    private handleSnapshot(payload: Uint8Array): void {
        try {
            const decoded = decodeDelta(
                this.world,
                payload,
                this.syncedComponents,
                this.syncedNumMaskWords,
                (serverEid, present) => this.ensureEntity(serverEid, present),
                // Never overwrite live state from the snapshot path.
                // Predicted entities go through reconcile; peer entities
                // go through the buffer's `sync` apply. decodeDelta still
                // archetype-inits first-appearance components.
                () => false,
            );
            this.lastServerTick = decoded.tick;
            this.emit('snapshot', { tick: decoded.tick, byteSize: payload.length + 1 });

            this.interpBuffer.record({
                receivedAt: performance.now(),
                serverTick: decoded.tick,
                entityIds: decoded.serverEntityIds,
                componentValuesByEntity: decoded.valuesByServerEntity,
            });

            for (const serverEid of decoded.despawnedServerIds) {
                const localEid = this.serverToLocal.get(serverEid);
                if (localEid === undefined) continue;
                this.serverToLocal.delete(serverEid);
                this.interpBuffer.forget(serverEid);
                if (this.world.isAlive(localEid)) this.world.despawn(localEid);
                this.emit('despawn', { entity: localEid });
            }

            this.reconcile(decoded);
        } catch (err) {
            this.emit('error', { error: err as Error, context: 'handleSnapshot' });
        }
    }

    private ensureEntity(serverEid: number, present: Component<any>[]): Entity {
        let localEid = this.serverToLocal.get(serverEid);
        if (localEid === undefined) {
            localEid = this.world.spawn();
            this.serverToLocal.set(serverEid, localEid);
            const components: Record<string, unknown> = {};
            for (const c of present) components[c.name] = true;
            this.emit('spawn', { entity: localEid, components });

            if (this.pendingAssignedServerEid === serverEid) {
                this.pendingAssignedServerEid = null;
                this.predictedEntities.add(localEid);
                this._assignedEntity = localEid;
                this.emit('assigned', { entity: localEid });
            }
        }
        return localEid;
    }

    private applyAssignment(serverEid: number): void {
        const localEid = this.serverToLocal.get(serverEid);
        if (localEid === undefined) {
            this.pendingAssignedServerEid = serverEid;
            return;
        }
        this.predictedEntities.add(localEid);
        this._assignedEntity = localEid;
        this.emit('assigned', { entity: localEid });
    }

    /**
     * Rewind predicted entities to authoritative state, drop predictions
     * the server has acked, replay the rest on top.
     */
    private reconcile(decoded: DecodedDelta): void {
        for (const serverEid of decoded.serverEntityIds) {
            const localEid = this.serverToLocal.get(serverEid);
            if (localEid === undefined) continue;
            if (!this.predictedEntities.has(localEid)) continue;
            const comps = decoded.valuesByServerEntity.get(serverEid);
            if (comps === undefined) continue;
            for (const [c, value] of comps) {
                if (this.world.has(localEid, c)) {
                    this.world.update(localEid, c, value as any);
                } else {
                    this.world.add(localEid, c, value as any);
                }
            }
        }

        // Drop predictions by CLIENT tick (not server tick).
        const ackTick = decoded.clientAckTick;
        let cut = 0;
        while (
            cut < this.predictionHistory.length &&
            this.predictionHistory[cut].tick <= ackTick
        ) {
            cut++;
        }
        if (cut > 0) this.predictionHistory.splice(0, cut);

        const remaining = this.predictionHistory.length;
        if (remaining === 0) {
            this.emit('reconciled', { rewindTick: ackTick, replayed: 0 });
            return;
        }

        for (let i = 0; i < remaining; i++) {
            const pred = this.predictionHistory[i];
            const predFn = this.predictionMap?.[pred.name as keyof typeof this.predictionMap];
            if (predFn === undefined) continue;
            const ctx: PredictionContext = {
                world: this.world,
                entity: pred.entity,
                tick: pred.tick,
                deltaTime: pred.deltaTime,
                rng: this.rng,
                fields: makeFieldsAccessor(this.world, pred.entity),
                markDirty: makeMarkDirty(this.world, pred.entity),
            };
            (predFn as any)(pred.payload, ctx);
        }
        this.emit('reconciled', {
            rewindTick: ackTick,
            replayed: remaining,
        });
    }

    private handleRpc(payload: Uint8Array): void {
        try {
            const { method, data } = this.rpcs.registry.decode(payload);
            this.emit('rpc', { name: method, payload: data });
        } catch (err) {
            this.emit('error', { error: err as Error, context: 'handleRpc' });
        }
    }

    use(bundle: DefinedPredictions<I>): this;
    use(bundle: any): this {
        if (bundle && bundle.__kind === 'predictions') {
            this.predictionMap = bundle.map;
            return this;
        }
        return this;
    }

    /**
     * Send an intent to the server. `ctx.entity` in the prediction is the
     * server-assigned entity. Target entities (chestId, targetId, etc.)
     * belong in the payload itself.
     *
     * Returns `true` when the intent was sent, `false` when blocked. Both
     * blocked paths emit an `'error'` event so calling code can react:
     * - Unknown intent name.
     * - No entity assigned yet (server hasn't called `assignEntity` for
     *   this peer). Check `client.assignedEntity` if you want to know
     *   without sending.
     */
    sendIntent<K extends keyof I & string>(
        name: K,
        payload: IntentPayload<I, K>,
    ): boolean {
        const def = this.intents.defs[name];
        if (def === undefined) {
            this.emit('error', {
                error: new Error(`Unknown intent "${String(name)}"`),
                context: 'sendIntent',
            });
            return false;
        }

        const entity = this._assignedEntity;
        if (entity === null) {
            this.emit('error', {
                error: new Error(`Cannot send intent "${String(name)}": no entity assigned yet`),
                context: 'sendIntent',
            });
            return false;
        }

        const intentObj = { ...(payload as Record<string, unknown>), kind: def.kind, tick: this.localTick };

        const encoded = this.intents.registry.encode(intentObj);
        const framed = new Uint8Array(encoded.length + 1);
        framed[0] = CMSG_INTENT;
        framed.set(encoded, 1);
        this.transport.send(framed);

        const predFn = this.predictionMap?.[name as keyof typeof this.predictionMap];
        if (predFn !== undefined) {
            const deltaTime = this.lastDt;
            const ctx: PredictionContext = {
                world: this.world,
                entity,
                tick: this.localTick,
                deltaTime,
                rng: this.rng,
                fields: makeFieldsAccessor(this.world, entity),
                markDirty: makeMarkDirty(this.world, entity),
            };
            (predFn as any)(payload, ctx);
            this.predictionHistory.push({
                tick: this.localTick,
                name,
                payload,
                entity,
                deltaTime,
            });
            this.predictedEntities.add(entity);
            while (this.predictionHistory.length > this.predictionBufferSize) {
                this.predictionHistory.shift();
            }
        }

        return true;
    }

    sendRpc<K extends keyof R & string>(name: K, payload: RpcPayload<R, K>): void {
        const def = this.rpcs.defs[name];
        if (def === undefined) {
            this.emit('error', {
                error: new Error(`Unknown RPC "${String(name)}"`),
                context: 'sendRpc',
            });
            return;
        }
        const encoded = this.rpcs.registry.encode(def, payload as any);
        const framed = new Uint8Array(encoded.length + 1);
        framed[0] = CMSG_RPC;
        framed.set(encoded, 1);
        this.transport.send(framed);
    }

    getLocalTick(): number {
        return this.localTick;
    }

    getPredictionDepth(): number {
        return this.predictionHistory.length;
    }

    get interpolationDelayMs(): number {
        return this.interpolationDelay;
    }

    setInterpolationDelay(ms: number): void {
        this.interpolationDelay = ms;
        this.interpBuffer.setDelay(ms);
    }
}

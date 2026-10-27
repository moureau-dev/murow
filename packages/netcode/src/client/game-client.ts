import { u16 } from 'murow/core/binary-codec';
import { SimpleRNG } from 'murow/core/simple-rng';
import { Reconciler } from 'murow/core/prediction';
import type { Component, Entity, World } from 'murow/ecs';
import type { GameLoop } from 'murow/game';
import type { TransportAdapter } from 'murow/net';
import { ClientMessage, ServerMessage, packet, packetType, packetPayload } from 'murow/net/wire';
import { defineRPC, type Protocol } from 'murow/protocol';
import { Network } from '../network/base';
import { decodeDelta, type DecodedDelta } from '../codec/delta-codec';
import { SnapshotInterpolationStrategy, PeerRenderStrategy, createStrategy } from './strategies';
import type { PeerRenderStrategyConfig } from './strategies';
import type { DefinedIntents, IntentPayload, IntentSchemaMap } from '../intents/define-intents';
import type { DefinedRpcs, RpcPayload, RpcSchemaMap } from '../rpcs/define-rpcs';
import type { DefinedPredictions } from '../predictions/define-predictions';
import type { SyncSpec } from '../components/sync-spec';
import { Logger } from 'murow/core/logger';
import { computeSchemaFingerprint } from '../codec/fingerprint';
import { SlotSet } from 'murow/core/slot-map';
import { ServerEntityMap } from './server-entity-map';
import { SnapshotPool } from '../codec/snapshot-pool';
import { makeFieldsAccessor, makeMarkDirty, type PredictionContext } from '../ctx';
import type { DefinedSnapshots, SnapshotSchemaMap, MessagePayload } from '../messages';

const {
    Snapshot: MSG_SNAPSHOT,
    Rpc: MSG_RPC,
    Kick: MSG_KICK,
    AssignEntity: MSG_ASSIGN_ENTITY,
    Schema: MSG_SCHEMA,
    Session: MSG_SESSION,
    Custom: MSG_CUSTOM,
    SyncComplete: MSG_SYNC_COMPLETE,
    Outcome: MSG_OUTCOME,
} = ServerMessage;

const {
    Intent: CMSG_INTENT,
    Rpc: CMSG_RPC,
    KickAck: CMSG_KICK_ACK,
    Resume: CMSG_RESUME,
    Message: CMSG_MESSAGE,
    SyncAck: CMSG_SYNC_ACK,
} = ClientMessage;

const PING_RPC = defineRPC({ method: '__murow_ping', schema: { ts: u16 } });
const PONG_RPC = defineRPC({ method: '__murow_pong', schema: { ts: u16 } });

interface PredictedIntent {
    tick: number;
    sequence: number;
    name: string;
    payload: any;
    entity: Entity;
    deltaTime: number;
}

/**
 * Peer-render strategies (how received snapshots become rendered peer state)
 * live in `./strategies`. `SnapshotInterpolationStrategy` is the default; a
 * strategy `create()`s a `PeerRenderer` from a shared context. Local-player
 * rendering is driven by `prediction` (a separate axis).
 */

export interface GameClientOptions<
    I extends IntentSchemaMap,
    R extends RpcSchemaMap,
    S extends SnapshotSchemaMap = SnapshotSchemaMap,
> {
    world: World;
    loop: GameLoop<any>;
    transport: TransportAdapter;
    protocol:
        | Protocol<I, R, S>
        | {
              intents: DefinedIntents<I>;
              rpcs: DefinedRpcs<R>;
              /** Legacy name for custom message types. */
              snapshots?: DefinedSnapshots<S>;
          };
    /**
     * Peer-rendering strategy: a `{ kind, ...opts }` config (see
     * `PeerRenderStrategyConfig`) or a `PeerRenderStrategy` instance. Defaults
     * to `{ kind: 'snapshot-interpolation', delay: 100 }`.
     */
    strategy?: PeerRenderStrategyConfig | PeerRenderStrategy;
    prediction?: {
        /** Max buffered unacked predictions kept for rollback. Default 64. */
        bufferSize?: number;
    };
    /**
     * Resume this client's server session after a transport drop, instead of
     * being treated as a new peer. Pass the token from a prior session
     * (`client.sessionToken`) to resume across a full reload; the live client
     * reuses it automatically on reconnect.
     */
    reconnection?: boolean | { token?: string };
    now?: () => number;
    /**
     * Retransmit an intent when its oldest unacked packet has been in flight for
     * at least this many milliseconds. `0` (default) disables retransmission.
     * The server dedups by sequence, so a resend of an already-applied intent
     * is a no-op.
     */
    retransmitMs?: number;
    /** Optional diagnostics: `true` → console logger, or pass a `Logger`. */
    debug?: boolean | Logger;
    /**
     * Override the schema fingerprint the client expects from the server.
     * Defaults to a fingerprint computed from the synced components; a mismatch
     * fires an `'error'` with context `'schema-fingerprint'`.
     */
    schemaFingerprint?: string;
}

export class GameClient<
    I extends IntentSchemaMap = IntentSchemaMap,
    R extends RpcSchemaMap = RpcSchemaMap,
    S extends SnapshotSchemaMap = SnapshotSchemaMap,
> extends Network<'client', R, S> {
    readonly world: World;
    readonly loop: GameLoop<any>;
    readonly transport: TransportAdapter;
    readonly intents: DefinedIntents<I>;
    readonly rpcs: DefinedRpcs<R>;
    private readonly snapshots: DefinedSnapshots<S> | undefined;

    private predictionMap: DefinedPredictions<I>['map'] | null = null;
    private predictionBufferSize: number;
    private reconciler: Reconciler<PredictedIntent, { decoded: DecodedDelta; resetEntities: SlotSet }>;

    private localTick = 0;
    private intentSequence = 0;
    private lastServerTick = 0;
    private lastReconciledServerTick = 0;

    private serverToLocal!: ServerEntityMap;
    private readonly snapshotPool = new SnapshotPool();
    private syncedComponents: Component<any>[] = [];
    private syncedNumMaskWords = 1;
    private rng: SimpleRNG;
    private lastDt: number;
    private predictedEntities = new Set<Entity>();
    private _sessionToken = '';
    private resumeEnabled = false;
    /** Set when MSG_ASSIGN_ENTITY lands before the matching spawn. */
    private pendingAssignedServerEid: number | null = null;
    /** Spawns discovered during a decode, emitted once values are written. */
    private deferredSpawns: { entity: Entity; components: Record<string, unknown>; assigned: boolean }[] = [];
    /** Resolved local entity for the server's assignment. Default for sendIntent. */
    private _assignedEntity: Entity | null = null;
    interpBuffer: PeerRenderStrategy;
    private _rttMs: number | null = null;
    private retransmitMs = 0;
    private readonly unackedIntents = new Map<number, { packet: Uint8Array; sentAt: number }>();
    private _initialized = false;
    /** Baseline channels not yet received (order-independent completion). */
    private readonly pendingBaseline = new Set<string>();
    private entityBaselineSeen = false;
    private now: () => number;
    private readonly log: Logger;
    /** Fingerprint of the synced schema (or the `schemaFingerprint` option). */
    readonly schemaFingerprint: string;

    /**
     * Local entity the server has assigned to this peer, or `null` if no
     * assignment has been received yet. `sendIntent` is a no-op (emits an
     * `'error'` event) until this is set.
     */
    get assignedEntity(): Entity | null {
        return this._assignedEntity;
    }

    /**
     * Last measured round-trip time in milliseconds, or `null` if no pong
     * has come back yet. Updated whenever a `'pong'` event fires.
     */
    get rttMs(): number | null {
        return this._rttMs;
    }

    /** True once every channel's initial state has been applied. */
    get initialized(): boolean {
        return this._initialized;
    }

    constructor(opts: GameClientOptions<I, R, S>) {
        super([
            'connected',
            'disconnected',
            'session',
            'reconnected',
            'kicked',
            'snapshot',
            'rpc',
            'message',
            'initialized',
            'outcome',
            'intent-retransmit',
            'spawn',
            'despawn',
            'reconciled',
            'assigned',
            'pong',
            'error',
        ]);
        this.world = opts.world;
        this.serverToLocal = new ServerEntityMap(this.world.getMaxEntities());
        this.reconcileCtx = { decoded: null, resetEntities: new SlotSet(this.world.getMaxEntities()) };
        this.loop = opts.loop;
        this.transport = opts.transport;
        {
            const rc = opts.reconnection;
            this.resumeEnabled = rc !== undefined && rc !== false;
            if (typeof rc === 'object' && rc.token !== undefined) this._sessionToken = rc.token;
        }
        const protocol = opts.protocol;
        this.intents = protocol.intents;
        this.rpcs = protocol.rpcs;
        this.snapshots = 'messages' in protocol ? protocol.messages : protocol.snapshots;
        const protocolFingerprint = 'fingerprint' in protocol ? protocol.fingerprint : '';
        this.resetBaseline();
        const reg = this.rpcs.registry as any;
        if (!reg.has(PING_RPC.method)) reg.register(PING_RPC);
        if (!reg.has(PONG_RPC.method)) reg.register(PONG_RPC);
        this.predictionBufferSize = opts.prediction?.bufferSize ?? 64;
        this.rng = new SimpleRNG(1);
        this.log = Logger.resolve(opts.debug, 'net-client');
        this.lastDt = opts.loop.ticker.intervalMs / 1000;
        this.now = opts.now ?? (() => performance.now());
        this.retransmitMs = opts.retransmitMs ?? 0;

        // 16 slots covers ~800ms at 20Hz.
        const strategy = opts.strategy;
        this.interpBuffer =
            strategy === undefined
                ? new SnapshotInterpolationStrategy()
                : strategy instanceof PeerRenderStrategy
                    ? strategy
                    : createStrategy(strategy);
        this.interpBuffer.bind({
            serverToLocal: this.serverToLocal,
            now: this.now,
            tickIntervalMs: opts.loop.ticker.intervalMs,
            capacity: 16,
            snapshotPool: this.snapshotPool,
        });

        this.reconciler = new Reconciler({
            bufferSize: this.predictionBufferSize,
            restore: ({ decoded, resetEntities }) => {
                for (const serverEid of decoded.serverEntityIds) {
                    const localEid = this.serverToLocal.get(serverEid);
                    if (localEid === undefined) continue;
                    if (!this.predictedEntities.has(localEid)) continue;
                    const comps = decoded.valuesByServerEntity.get(serverEid);
                    if (comps === undefined) continue;
                    for (let ci = 0; ci < comps.length; ci++) {
                        const c = this.syncedComponents[ci];
                        const value = comps[ci];
                        if (c === undefined || value == null) continue;
                        // Per-component snap dead-zone: a correction smaller than
                        // the component's `snapThreshold` keeps the predicted value
                        // (smooths) instead of hard-snapping.
                        const threshold = (c.__sync as SyncSpec | undefined)?.snapThreshold;
                        const present = this.world.has(localEid, c);
                        const fields = present ? (this.world.fields(c) as any) : null;
                        const incoming = value as Record<string, number>;
                        if (threshold !== undefined && fields !== null) {
                            let within = true;
                            for (const f of c.fieldNames as string[]) {
                                const a = fields[f][localEid] as number;
                                const b = incoming[f];
                                if (typeof a !== 'number' || typeof b !== 'number' || Math.abs(a - b) > threshold) {
                                    within = false;
                                    break;
                                }
                            }
                            if (within) continue;
                        }
                        if (fields !== null) {
                            for (const f of c.fieldNames as string[]) fields[f][localEid] = incoming[f];
                        } else {
                            this.world.add(localEid, c, value as any);
                        }
                    }
                    resetEntities.add(localEid);
                }
            },
            replay: (preds, { decoded, resetEntities }) => {
                let replayedCount = 0;
                for (const pred of preds) {
                    if (!resetEntities.has(pred.entity)) continue;
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
                    replayedCount++;
                }
                this.emit('reconciled', { rewindTick: decoded.clientAckTick, replayed: replayedCount });
            },
        });

        this.discoverSyncedComponents();
        const componentFingerprint = computeSchemaFingerprint(this.syncedComponents);
        this.schemaFingerprint = opts.schemaFingerprint
            ?? (protocolFingerprint === '' ? componentFingerprint : `${componentFingerprint}:${protocolFingerprint}`);
        this.wireTransport();
        this.wireLoop();
    }

    private discoverSyncedComponents(): void {
        const all = this.world.getComponents() as Component<any>[];
        for (const c of all) {
            if (c.__sync !== undefined) this.syncedComponents.push(c);
        }
        this.syncedNumMaskWords = Math.max(1, Math.ceil(this.syncedComponents.length / 32));
    }

    private wireTransport(): void {
        this.transport.onOpen?.(() => {
            this.log.info('connected');
            this.emit('connected', {});
            if (this.resumeEnabled) this.sendResume();
        });
        this.transport.onMessage((data) => this.handleIncoming(data));
        this.transport.onClose(() => { this.log.info('disconnected'); this.emit('disconnected', { reason: 'transport-closed' }); });
        this.transport.onError?.((error: Error) => this.emit('error', { error, context: 'transport' }));
    }

    private wireLoop(): void {
        const events = this.loop.events as any;
        events.on('sync', () => {
            this.interpBuffer.apply(
                this.world,
                this.now(),
                this.syncedComponents,
                (e) => this.predictedEntities.has(e),
            );
        });

        events.on('tick', ({ deltaTime }: any) => {
            this.localTick++;
            this.lastDt = deltaTime;
            this.retransmitOldest();
        });
    }

    /** The current session token, learned from the server or supplied via options. */
    get sessionToken(): string {
        return this._sessionToken;
    }

    private sendResume(): void {
        const bytes = new TextEncoder().encode(this._sessionToken);
        this.transport.send(packet(CMSG_RESUME, bytes));
    }

    private handleSession(data: Uint8Array): void {
        const resumed = data.length >= 2 && data[1] === 1;
        this._sessionToken = new TextDecoder().decode(data.subarray(2));
        this.emit('session', { token: this._sessionToken, resumed });
        if (resumed) {
            this.resetBaseline();
            this.emit('reconnected', {});
        }
    }

    private handleIncoming(data: Uint8Array): void {
        if (data.length === 0) return;
        const type = packetType(data);

        if (type === MSG_SNAPSHOT) {
            this.handleSnapshot(packetPayload(data));
            return;
        }
        if (type === MSG_RPC) {
            this.handleRpc(packetPayload(data));
            return;
        }
        if (type === MSG_KICK) {
            const reason = new TextDecoder().decode(packetPayload(data));
            this.log.warn('kicked', { reason });
            this.emit('kicked', { reason });
            this.transport.send(packet(CMSG_KICK_ACK));
            return;
        }
        if (type === MSG_ASSIGN_ENTITY) {
            if (data.length < 5) {
                this.emit('error', {
                    error: new Error('MSG_ASSIGN_ENTITY packet too short'),
                    context: 'handleIncoming',
                });
                return;
            }
            const view = new DataView(data.buffer, data.byteOffset + 1, 4);
            this.applyAssignment(view.getUint32(0, true));
            return;
        }
        if (type === MSG_SESSION) {
            this.handleSession(data);
            return;
        }
        if (type === MSG_CUSTOM) {
            this.handleMessage(packetPayload(data));
            return;
        }
        if (type === MSG_SYNC_COMPLETE) {
            this.entityBaselineSeen = true;
            this.checkInitialized();
            return;
        }
        if (type === MSG_OUTCOME) {
            this.handleOutcome(packetPayload(data));
            return;
        }
        if (type === MSG_SCHEMA) {
            const fp = new TextDecoder().decode(packetPayload(data));
            if (fp !== this.schemaFingerprint) {
                this.log.error('schema fingerprint mismatch', { server: fp, client: this.schemaFingerprint });
                this.emit('error', {
                    error: new Error(`schema fingerprint mismatch: server ${fp} != client ${this.schemaFingerprint}`),
                    context: 'schema-fingerprint',
                });
            }
            return;
        }
        this.log.warn('unknown server message type', { type });
        this.emit('error', {
            error: new Error(`Unknown server message type 0x${type.toString(16)}`),
            context: 'handleIncoming',
        });
    }

    private handleSnapshot(payload: Uint8Array): void {
        try {
            this.deferredSpawns.length = 0;
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
                this.snapshotPool,
            );
            this.lastServerTick = decoded.tick;

            for (const spawn of this.deferredSpawns) {
                this.emit('spawn', { entity: spawn.entity, components: spawn.components });
                if (spawn.assigned) this.emit('assigned', { entity: spawn.entity });
            }
            this.deferredSpawns.length = 0;

            this.emit('snapshot', { tick: decoded.tick, byteSize: payload.length + 1 });

            this.interpBuffer.record({
                receivedAt: this.now(),
                serverTick: decoded.tick,
                entityIds: decoded.serverEntityIds,
                componentValuesByEntity: decoded.valuesByServerEntity,
            });

            for (const serverEid of decoded.despawnedServerIds) {
                const localEid = this.serverToLocal.get(serverEid);
                if (localEid === undefined) continue;
                this.serverToLocal.delete(serverEid);
                if (this.world.isAlive(localEid)) this.world.despawn(localEid);
                this.emit('despawn', { entity: localEid });
            }

            if (decoded.tick <= this.lastReconciledServerTick) return;
            this.lastReconciledServerTick = decoded.tick;

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

            let assigned = false;
            if (this.pendingAssignedServerEid === serverEid) {
                this.pendingAssignedServerEid = null;
                this.predictedEntities.add(localEid);
                this._assignedEntity = localEid;
                assigned = true;
            }

            this.deferredSpawns.push({ entity: localEid, components, assigned });
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
    private readonly reconcileCtx: { decoded: DecodedDelta | null; resetEntities: SlotSet };

    private reconcile(decoded: DecodedDelta): void {
        this.reconcileCtx.decoded = decoded;
        this.reconcileCtx.resetEntities.clear();
        this.reconciler.reconcile(decoded.clientAckTick, this.reconcileCtx as { decoded: DecodedDelta; resetEntities: SlotSet });
        if (this.retransmitMs > 0) this.clearAcked(decoded.clientAckTick);
    }

    private handleRpc(payload: Uint8Array): void {
        try {
            const { method, data } = this.rpcs.registry.decode(payload);
            if (method === '__murow_pong') {
                const rtt = (Date.now() - (data as { ts: number }).ts) & 0xFFFF;
                this._rttMs = rtt;
                this.emit('pong', { rtt });
            }
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
        const sequence = ++this.intentSequence;
        const packet = new Uint8Array(encoded.length + 5);
        packet[0] = CMSG_INTENT;
        const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        dv.setUint32(1, sequence >>> 0, true);
        packet.set(encoded, 5);
        this.transport.send(packet);
        if (this.retransmitMs > 0) this.unackedIntents.set(sequence, { packet, sentAt: this.now() });

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
            this.reconciler.record(sequence, {
                tick: this.localTick,
                sequence,
                name,
                payload,
                entity,
                deltaTime,
            });
            this.predictedEntities.add(entity);
        }

        return true;
    }

    /** Send a custom message to the server. */
    sendMessage<K extends keyof S & string>(name: K, payload: MessagePayload<S, K>): void {
        const snapshots = this.snapshots;
        if (snapshots === undefined) return;
        const encoded = snapshots.registry.encode(name as string, { tick: 0, updates: payload as any });
        this.transport.send(packet(CMSG_MESSAGE, encoded));
    }

    /** Drop unacked intent packets the server has acked. Sequences are inserted in order, so stop at the first survivor. */
    private clearAcked(ack: number): void {
        for (const sequence of this.unackedIntents.keys()) {
            if (sequence > ack) break;
            this.unackedIntents.delete(sequence);
        }
    }

    /** Resend the oldest unacked intent packet when it has been in flight past `retransmitMs`. */
    private retransmitOldest(): void {
        if (this.retransmitMs <= 0 || this.unackedIntents.size === 0) return;
        let oldest = Infinity;
        for (const sequence of this.unackedIntents.keys()) {
            if (sequence < oldest) oldest = sequence;
        }
        const entry = this.unackedIntents.get(oldest);
        if (entry === undefined) return;
        const now = this.now();
        if (now - entry.sentAt < this.retransmitMs) return;
        entry.sentAt = now;
        this.transport.send(entry.packet);
        this.emit('intent-retransmit', { sequence: oldest });
    }

    private resetBaseline(): void {
        this.unackedIntents.clear();
        this.pendingBaseline.clear();
        const keys = this.snapshots?.baselineKeys ?? [];
        for (let i = 0; i < keys.length; i++) this.pendingBaseline.add(keys[i]!);
        this.entityBaselineSeen = false;
        this._initialized = false;
    }

    private checkInitialized(): void {
        if (this._initialized || !this.entityBaselineSeen || this.pendingBaseline.size > 0) return;
        this._initialized = true;
        this.emit('initialized', {});
        this.transport.send(packet(CMSG_SYNC_ACK));
    }

    private handleOutcome(bytes: Uint8Array): void {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = dv.getUint16(0, true);
        let off = 2;
        for (let i = 0; i < count; i++) {
            const sequence = dv.getUint32(off, true); off += 4;
            const accepted = dv.getUint8(off) === 1; off += 1;
            const reason = dv.getUint16(off, true); off += 2;
            this.emit('outcome', { sequence, accepted, reason });
        }
    }

    private handleMessage(bytes: Uint8Array): void {
        const snapshots = this.snapshots;
        if (snapshots === undefined) return;
        try {
            const { type, snapshot } = snapshots.registry.decode(bytes);
            this.emit('message', { name: type, payload: snapshot.updates } as never);
            if (this.pendingBaseline.delete(type)) this.checkInitialized();
        } catch (err) {
            this.emit('error', { error: err as Error, context: 'handleMessage' });
        }
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
        this.transport.send(packet(CMSG_RPC, encoded));
    }

    ping(): void {
        const ts = Date.now() & 0xFFFF;
        const encoded = (this.rpcs.registry as any).encode(PING_RPC, { ts }) as Uint8Array;
        this.transport.send(packet(CMSG_RPC, encoded));
    }

    getLocalTick(): number {
        return this.localTick;
    }

    getPredictionDepth(): number {
        return this.reconciler.pending;
    }

    get interpolationDelay(): number {
        return this.interpBuffer.delay;
    }

    setInterpolationDelay(ms: number): void {
        this.interpBuffer.setDelay(ms);
    }

    setMaxDesync(ms: number): void {
        this.interpBuffer.setMaxDesync(ms);
    }

    setMaxBridgeGap(ms: number): void {
        this.interpBuffer.setMaxBridgeGap(ms);
    }
}

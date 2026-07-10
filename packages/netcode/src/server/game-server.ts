import { SimpleRNG } from 'murow/core/simple-rng';
import type { Component, Entity, World } from 'murow/ecs';
import type { GameLoop } from 'murow/game';
import type { ServerTransportAdapter, TransportAdapter } from 'murow/net';
import { u16 } from 'murow/core/binary-codec';
import { defineRPC } from 'murow/protocol';
import { Network } from '../network/base';
import { encodeDelta } from '../codec/delta-codec';
import { rateIncludes, type SyncSpec } from '../components/sync-spec';
import type { DefinedIntents, IntentSchemaMap } from '../intents/define-intents';
import type { DefinedRpcs, RpcPayload, RpcSchemaMap } from '../rpcs/define-rpcs';
import type { DefinedPredictions } from '../predictions/define-predictions';
import type { DefinedHandlers } from '../handlers/define-handlers';
import type { ServerPlugin } from './plugins/plugin';
import type { LagCompensation } from './plugins/lag-compensation';
import { makeFieldsAccessor, makeMarkDirty, type Peer, type ServerHandlerContext } from '../ctx';

const PING_RPC = defineRPC({ method: '__murow_ping', schema: { ts: u16 } });
const PONG_RPC = defineRPC({ method: '__murow_pong', schema: { ts: u16 } });

// Server -> client frames. Reserved range to not collide with user
// intent kinds (which start at 1 in `defineIntents`).
const MSG_SNAPSHOT = 0x80;
const MSG_RPC = 0x81;
const MSG_KICK = 0x82;
const MSG_KICK_ACK = 0x83;
const MSG_ASSIGN_ENTITY = 0x84;

// Client -> server frames.
const CMSG_INTENT = 0x01;
const CMSG_RPC = 0x02;
const CMSG_KICK_ACK = 0x03;

export interface GameServerOptions<
    I extends IntentSchemaMap,
    R extends RpcSchemaMap,
> {
    world: World;
    loop: GameLoop<any>;
    transport: ServerTransportAdapter<TransportAdapter>;
    protocol: {
        intents: DefinedIntents<I>;
        rpcs: DefinedRpcs<R>;
    };
    snapshot?: {
        /** Snapshots per second. Clamped to tickRate. Default 20. */
        rate?: number;
    };
    kick?: {
        /** Ms before forcing transport close after a kick. Default 2000. */
        ackTimeout?: number;
    };
    /** Optional schema fingerprint for component-layout drift checks. */
    schemaFingerprint?: string;
}

interface KickingState {
    reason: string;
    sentAt: number;
    timer: ReturnType<typeof setTimeout>;
}

interface InternalPeer extends Peer {
    transport: TransportAdapter;
    kicking: KickingState | null;
    lastAckedClientTick: number;
    pendingBySequence: Map<number, Uint8Array>;
    /**
     * True until the peer has received its first snapshot. The first
     * snapshot ships every entity with any synced component, not just
     * the dirty delta, so newcomers see existing entities even if those
     * entities haven't mutated this tick.
     */
    needsBaseline: boolean;
    intentQueue: { sequence: number; payload: Uint8Array }[];
}

export class GameServer<
    I extends IntentSchemaMap = IntentSchemaMap,
    R extends RpcSchemaMap = RpcSchemaMap,
> extends Network<'server', R> {
    readonly world: World;
    readonly loop: GameLoop<any>;
    readonly transport: ServerTransportAdapter<TransportAdapter>;
    readonly intents: DefinedIntents<I>;
    readonly rpcs: DefinedRpcs<R>;

    private peers = new Map<string, InternalPeer>();
    private predictionMap: DefinedPredictions<I>['map'] | null = null;
    private handlerMap: DefinedHandlers<I>['map'] | null = null;
    private plugins: ServerPlugin[] = [];
    private lagComp: LagCompensation | null = null;
    private syncedComponents: Component<any>[] = [];
    private syncedNumMaskWords = 1;
    private snapshotEvery: number;
    private tickCounter = 0;
    private kickAckTimeout: number;
    private rng: SimpleRNG;
    private scratch: number[] = [];
    private lastDt: number;

    constructor(opts: GameServerOptions<I, R>) {
        super([
            'connection',
            'disconnection',
            'intent',
            'intent-failed',
            'rpc',
            'snapshot',
            'error',
        ]);
        this.world = opts.world;
        this.loop = opts.loop;
        this.transport = opts.transport;
        this.intents = opts.protocol.intents;
        this.rpcs = opts.protocol.rpcs;
        this.rng = new SimpleRNG(1);

        const reg = this.rpcs.registry as any;
        if (!reg.has(PING_RPC.method)) reg.register(PING_RPC);
        if (!reg.has(PONG_RPC.method)) reg.register(PONG_RPC);

        const tickRate = opts.loop.ticker.rate;
        const requestedSnapshotRate = opts.snapshot?.rate ?? Math.min(20, tickRate);
        const effectiveSnapshotRate = Math.min(requestedSnapshotRate, tickRate);
        this.snapshotEvery = Math.max(1, Math.round(tickRate / effectiveSnapshotRate));
        this.kickAckTimeout = opts.kick?.ackTimeout ?? 2000;
        this.lastDt = opts.loop.ticker.intervalMs / 1000;

        this.discoverSyncedComponents();
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
        this.transport.onConnection((peerTransport, peerId) => {
            const peer: InternalPeer = {
                peerId,
                entity: -1,
                transport: peerTransport,
                kicking: null,
                lastAckedClientTick: 0,
                pendingBySequence: new Map<number, Uint8Array>(),
                needsBaseline: true,
                intentQueue: [],
            };
            this.peers.set(peerId, peer);
            peerTransport.onMessage((data) => this.handleIncoming(peer, data));
            peerTransport.onClose?.(() => this.handleDisconnect(peer, 'transport-closed'));
            this.emit('connection', { peer });
        });

        this.transport.onDisconnection((peerId) => {
            const peer = this.peers.get(peerId);
            if (peer === undefined) return;
            this.handleDisconnect(peer, 'transport-closed');
        });
    }

    private handleDisconnect(peer: InternalPeer, reason: string): void {
        if (!this.peers.has(peer.peerId)) return;
        if (peer.kicking !== null) clearTimeout(peer.kicking.timer);
        this.peers.delete(peer.peerId);
        for (const plugin of this.plugins) plugin.onDisconnect?.(peer);
        this.emit('disconnection', { peer, reason });
    }

    private wireLoop(): void {
        const events = this.loop.events as any;
        events.on('pre-tick', () => {
            this.drainIntentQueues();
        });
        events.on('post-tick', ({ deltaTime }: any) => {
            this.tickCounter++;
            this.lastDt = deltaTime;

            for (const plugin of this.plugins) plugin.onTick?.(this.world, deltaTime);

            if (this.tickCounter % this.snapshotEvery !== 0) return;
            this.sendSnapshots();
        });
    }

    private drainIntentQueues(): void {
        this.peers.forEach((peer) => {
            if (peer.kicking !== null) {
                peer.intentQueue.length = 0;
                peer.pendingBySequence.clear();
                return;
            }

            for (let i = 0; i < peer.intentQueue.length; i++) {
                const entry = peer.intentQueue[i];
                if (entry.sequence <= peer.lastAckedClientTick) continue;
                if (peer.pendingBySequence.has(entry.sequence)) continue;
                peer.pendingBySequence.set(entry.sequence, entry.payload);
            }
            peer.intentQueue.length = 0;

            while (peer.pendingBySequence.has(peer.lastAckedClientTick + 1)) {
                const nextSequence = peer.lastAckedClientTick + 1;
                const payload = peer.pendingBySequence.get(nextSequence)!;
                peer.pendingBySequence.delete(nextSequence);
                this.handleIntent(peer, nextSequence, payload);
            }

            if (peer.pendingBySequence.size > 0) {
                const STALL_LIMIT = 16;
                let lowestPending = Infinity;
                for (const sequence of peer.pendingBySequence.keys()) {
                    if (sequence < lowestPending) lowestPending = sequence;
                }
                if (lowestPending - peer.lastAckedClientTick > STALL_LIMIT) {
                    peer.lastAckedClientTick = lowestPending - 1;
                    while (peer.pendingBySequence.has(peer.lastAckedClientTick + 1)) {
                        const nextSequence = peer.lastAckedClientTick + 1;
                        const payload = peer.pendingBySequence.get(nextSequence)!;
                        peer.pendingBySequence.delete(nextSequence);
                        this.handleIntent(peer, nextSequence, payload);
                    }
                }
            }
        });
    }

    private sendSnapshots(): void {
        if (this.syncedComponents.length === 0) return;

        // Union of dirty entities across all synced components.
        const seen = new Set<Entity>();
        this.scratch.length = 0;
        for (const c of this.syncedComponents) {
            this.world.forEachDirty(c, (eid) => {
                if (!seen.has(eid)) {
                    seen.add(eid);
                    this.scratch.push(eid);
                }
            });
        }

        const despawnedView = this.world.getDespawned();
        const despawned: number[] = despawnedView.length > 0 ? Array.from(despawnedView) : [];
        if (despawned.length > 0) this.world.flushDespawned();

        if (this.scratch.length === 0 && despawned.length === 0 && !this.anyNeedsBaseline()) {
            return;
        }

        // Built lazily; only if at least one peer needs a baseline.
        let baseline: Entity[] | null = null;
        const computeBaseline = (): Entity[] => {
            if (baseline !== null) return baseline;
            const result: Entity[] = [];
            const baselineSeen = new Set<Entity>();
            for (const c of this.syncedComponents) {
                for (const eid of this.world.query(c)) {
                    if (!baselineSeen.has(eid)) {
                        baselineSeen.add(eid);
                        result.push(eid);
                    }
                }
            }
            baseline = result;
            return result;
        };

        const peerOut: Entity[] = [];
        for (const peer of this.peers.values()) {
            if (peer.kicking !== null) continue;

            const source: ReadonlyArray<Entity> = peer.needsBaseline
                ? computeBaseline()
                : this.scratch;

            let current: ReadonlyArray<Entity> = source;
            for (const plugin of this.plugins) {
                if (plugin.filterSnapshot === undefined) continue;
                peerOut.length = 0;
                plugin.filterSnapshot(peer, this.world, current, peerOut);
                current = peerOut.slice();
            }

            // Baseline peers always send (even empty) so they get a tick
            // header + clientAckTick. Established peers skip empty deltas.
            if (current.length === 0 && despawned.length === 0 && !peer.needsBaseline) continue;

            const include = peer.needsBaseline
                ? undefined
                : (eid: Entity, c: Component<any>) =>
                      rateIncludes((c.__sync as SyncSpec).rate, this.world.isDirty(eid, c), this.tickCounter);

            const buf = encodeDelta(
                this.world,
                this.tickCounter,
                current as number[],
                this.syncedComponents,
                this.syncedNumMaskWords,
                despawned,
                peer.lastAckedClientTick,
                include,
            );

            const framed = new Uint8Array(buf.length + 1);
            framed[0] = MSG_SNAPSHOT;
            framed.set(buf, 1);
            peer.transport.send(framed);

            peer.needsBaseline = false;
            this.emit('snapshot', { peer, tick: this.tickCounter, byteSize: framed.length });
        }

        // Clear dirty for the next tick. Per-peer ack-driven resend on
        // packet loss is future work.
        this.world.clearAllDirty();
    }

    private anyNeedsBaseline(): boolean {
        for (const peer of this.peers.values()) {
            if (peer.kicking === null && peer.needsBaseline) return true;
        }
        return false;
    }

    private handleIncoming(peer: InternalPeer, data: Uint8Array): void {
        if (data.length === 0) return;
        const type = data[0];

        if (peer.kicking !== null) {
            // After kick: only KICK_ACK is processed.
            if (type === CMSG_KICK_ACK) this.completeKick(peer);
            return;
        }

        if (type === CMSG_INTENT) {
            if (data.length < 5) {
                this.emit('intent-failed', { peer, kind: -1, reason: 'decode-error' });
                return;
            }
            const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const sequence = dv.getUint32(1, true);
            peer.intentQueue.push({ sequence, payload: data.subarray(5) });
            return;
        }
        if (type === CMSG_RPC) {
            this.handleRpc(peer, data.subarray(1));
            return;
        }
        this.emit('error', {
            error: new Error(`Unknown client message type 0x${type.toString(16)}`),
            context: 'handleIncoming',
        });
    }

    private handleIntent(peer: InternalPeer, sequence: number, payload: Uint8Array): void {
        let intent: any;
        try {
            intent = this.intents.registry.decode(payload);
        } catch (err) {
            this.emit('intent-failed', {
                peer,
                kind: payload[0] ?? -1,
                reason: 'decode-error',
            });
            return;
        }

        const name = this.intents.nameByKind[intent.kind];
        if (name === undefined) {
            this.emit('intent-failed', {
                peer,
                kind: intent.kind,
                reason: 'unknown-kind',
            });
            return;
        }

        const ctx: ServerHandlerContext = {
            world: this.world,
            entity: peer.entity,
            tick: this.tickCounter,
            deltaTime: this.lastDt,
            rng: this.rng,
            fields: makeFieldsAccessor(this.world, peer.entity),
            markDirty: makeMarkDirty(this.world, peer.entity),
            peer,
            clientTick: intent.tick,
            lagCompensated: <T>(fn: () => T): T => {
                if (this.lagComp === null) return fn();
                return this.lagComp.rewind(intent.tick, fn);
            },
        };

        for (const plugin of this.plugins) {
            plugin.onIntent?.(peer, intent.kind, name, intent, ctx);
        }

        const predFn = this.predictionMap?.[name as keyof typeof this.predictionMap];
        if (predFn) (predFn as any)(intent, ctx);
        const handlerFn = this.handlerMap?.[name as keyof typeof this.handlerMap];
        if (handlerFn) (handlerFn as any)(intent, ctx);

        peer.lastAckedClientTick = sequence;

        this.emit('intent', {
            peer,
            kind: intent.kind,
            name,
            payload: intent,
            tick: intent.tick,
        });
    }

    private handleRpc(peer: InternalPeer, payload: Uint8Array): void {
        try {
            const decoded = (this.rpcs.registry as any).decode(payload) as { method: string; data: any };

            if (decoded.method === '__murow_ping') {
                const encoded = (this.rpcs.registry as any).encode(PONG_RPC, { ts: decoded.data.ts }) as Uint8Array;
                const framed = new Uint8Array(encoded.length + 1);
                framed[0] = MSG_RPC;
                framed.set(encoded, 1);
                peer.transport.send(framed);
                return;
            }

            this.emit('rpc', { peer, name: decoded.method, payload: decoded.data });
        } catch (err) {
            this.emit('error', { error: err as Error, context: 'handleRpc' });
        }
    }

    use(bundle: DefinedPredictions<I>): this;
    use(bundle: DefinedHandlers<I>): this;
    use(plugin: ServerPlugin): this;
    use(bundle: any): this {
        if (bundle && bundle.__kind === 'predictions') {
            this.predictionMap = bundle.map;
            return this;
        }
        if (bundle && bundle.__kind === 'handlers') {
            this.handlerMap = bundle.map;
            return this;
        }
        const plugin = bundle as ServerPlugin;
        this.plugins.push(plugin);
        plugin.onMount?.(this);
        if (plugin.name === 'lag-compensation' || (plugin as any).rewind !== undefined) {
            this.lagComp = plugin as unknown as LagCompensation;
        }
        return this;
    }

    /**
     * Bind an entity to a peer. Fills `ctx.entity` for the peer's intents
     * and pushes a MSG_ASSIGN_ENTITY frame so the client knows which
     * entity it owns.
     */
    assignEntity(peer: Peer, entityId: Entity): void {
        const internal = this.peers.get(peer.peerId);
        if (internal === undefined) return;
        internal.entity = entityId;

        // Frame: [MSG_ASSIGN_ENTITY][serverEntityId: u32]
        const frame = new Uint8Array(1 + 4);
        frame[0] = MSG_ASSIGN_ENTITY;
        new DataView(frame.buffer).setUint32(1, entityId >>> 0, true);
        internal.transport.send(frame);
    }

    sendRpc<K extends keyof R & string>(peer: Peer, name: K, payload: RpcPayload<R, K>): void {
        const internal = this.peers.get(peer.peerId);
        if (internal === undefined) return;
        if (internal.kicking !== null) return;
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
        framed[0] = MSG_RPC;
        framed.set(encoded, 1);
        internal.transport.send(framed);
    }

    broadcastRpc<K extends keyof R & string>(name: K, payload: RpcPayload<R, K>): void {
        for (const peer of this.peers.values()) {
            if (peer.kicking !== null) continue;
            this.sendRpc(peer, name, payload);
        }
    }

    /**
     * Soft-kick: send KICK frame, wait `kick.ackTimeout` for the client's
     * ack, then force the transport closed.
     */
    kick(peer: Peer, reason: string): void {
        const internal = this.peers.get(peer.peerId);
        if (internal === undefined) return;
        if (internal.kicking !== null) return;

        const reasonBytes = new TextEncoder().encode(reason);
        const framed = new Uint8Array(reasonBytes.length + 1);
        framed[0] = MSG_KICK;
        framed.set(reasonBytes, 1);
        internal.transport.send(framed);

        const timer = setTimeout(() => this.completeKick(internal), this.kickAckTimeout);
        internal.kicking = { reason, sentAt: Date.now(), timer };
    }

    private completeKick(peer: InternalPeer): void {
        if (peer.kicking === null) return;
        clearTimeout(peer.kicking.timer);
        // Fire `disconnection` before closing so the transport-close
        // handler sees the peer is already gone and exits.
        this.handleDisconnect(peer, 'kicked');
        peer.transport.close();
    }
}

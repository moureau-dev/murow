import { SimpleRNG } from 'murow/core/simple-rng';
import { SlotSet } from 'murow/core/slot-map';
import { Logger } from 'murow/core/logger';
import type { Component, Entity, World } from 'murow/ecs';
import type { GameLoop } from 'murow/game';
import type { ServerTransportAdapter, TransportAdapter } from 'murow/net';
import { u16 } from 'murow/core/binary-codec';
import { defineRPC } from 'murow/protocol';
import { Network } from '../network/base';
import { SnapshotEncoder, buildDeltaSchema } from '../codec/delta-codec';
import { computeSchemaFingerprint } from '../codec/fingerprint';
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
const MSG_SCHEMA = 0x85;
const MSG_SESSION = 0x86;

// Client -> server frames.
const CMSG_INTENT = 0x01;
const CMSG_RPC = 0x02;
const CMSG_KICK_ACK = 0x03;
const CMSG_RESUME = 0x04;

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
        /**
         * Soft per-peer byte cap for the entity body. When set, entities are
         * sent highest-priority first until the cap is reached; ones that do
         * not fit stay dirty and ship on a later tick.
         */
        maxBytesPerPeer?: number;
        /** Entity priority for the byte cap (higher sends first). Default: all equal. */
        priority?: (entity: Entity, world: World) => number;
    };
    kick?: {
        /** Ms before forcing transport close after a kick. Default 2000. */
        ackTimeout?: number;
    };
    /**
     * Hold a dropped peer's session (assigned entity + intent-ack cursor) so a
     * reconnecting client can resume it instead of being treated as new.
     * `graceMs` is how long it is held. Off by default.
     */
    reconnection?: { graceMs?: number };
    /**
     * Schema fingerprint checked against each client. Defaults to one derived
     * from the synced components; a mismatch fires the client's `'error'` with
     * context `'schema-fingerprint'`.
     */
    schemaFingerprint?: string;
    /** Optional diagnostics: `true` → console logger, or pass a `Logger`. */
    debug?: boolean | Logger;
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
    /** Incoming intents, as two parallel arrays (no per-intent object). */
    intentSeqs: number[];
    intentPayloads: Uint8Array[];
    /** Server entities currently visible to this peer (interest-aware). */
    visible: SlotSet;
    /** Resume token for this peer's session. */
    token: string;
    /** True once the resume handshake resolved (resumed or treated as new). */
    resolved: boolean;
    /** True when this connection resumed a held session. */
    resumed: boolean;
    /** Timer that resolves the handshake when no resume frame arrives. */
    handshakeTimer: ReturnType<typeof setTimeout> | null;
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
    /** One reused visibility set per plugin (indexed by registration order). */
    private interestSets: SlotSet[] = [];
    private interestIndex: Record<string, number> = Object.create(null);
    private readonly interestOut: Entity[] = [];
    /** First plugin providing both `nearby` and `covers` (the spatial fast path). */
    private nearbyPlugin: ServerPlugin | null = null;
    private readonly nearbyOut: Entity[] = [];
    /** Dirty entities the spatial plugin does not cover (pass-through). */
    private readonly passThrough: Entity[] = [];
    private tickCounter = 0;
    private kickAckTimeout: number;
    private rng: SimpleRNG;
    private scratch: number[] = [];
    private lastDt: number;
    private readonly log: Logger;
    /** Stable fingerprint of the synced schema (or the `schemaFingerprint` option). */
    readonly schemaFingerprint: string;
    private readonly dirtySeen: SlotSet;
    private readonly visibleScratch: SlotSet;
    private readonly baselineSeen: SlotSet;
    private readonly peerDespawned: number[] = [];
    private readonly candidates: number[] = [];
    private readonly budgetEids: number[] = [];
    private readonly budgetBytesArr: number[] = [];
    private readonly budgetPri: number[] = [];
    private readonly budgetOrder: number[] = [];
    private readonly byPriDesc = (a: number, b: number): number => this.budgetPri[b]! - this.budgetPri[a]!;
    private readonly retainDirty: SlotSet;
    /** Per-synced-component, per-field wire size in bytes (quantization-aware). */
    private readonly syncedWireSize: number[][] = [];
    private budgetBytes = 0;
    private priorityFn: ((entity: Entity, world: World) => number) | null = null;
    private encoder!: SnapshotEncoder;
    private currentPeer: InternalPeer | null = null;
    private currentCandidates: Entity[] | null = null;
    private interestBuilt = false;
    /** Reused encoder callback (one closure for all peers); reads `currentPeer`. */
    private readonly encoderInclude = (eid: number, c: Component<any>): boolean =>
        this.includeFor(this.currentPeer!, eid, c);
    /** Stable `forEachDirty` callback, so no closure is made per component per tick. */
    private readonly collectDirty = (eid: Entity): void => {
        if (this.dirtySeen.add(eid)) this.scratch.push(eid);
    };
    private reconnection: { graceMs: number } | null = null;
    private nextSession = 0;
    private readonly sessionSalt = Math.random().toString(36).slice(2, 10);
    private readonly sessions = new Map<
        string,
        { entity: Entity | -1; lastAckedClientTick: number; timer: ReturnType<typeof setTimeout> }
    >();

    constructor(opts: GameServerOptions<I, R>) {
        super([
            'connection',
            'disconnection',
            'suspended',
            'reconnection',
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
        this.log = Logger.resolve(opts.debug, 'net-server');
        this.dirtySeen = new SlotSet(this.world.getMaxEntities());
        this.visibleScratch = new SlotSet(this.world.getMaxEntities());
        this.baselineSeen = new SlotSet(this.world.getMaxEntities());
        this.retainDirty = new SlotSet(this.world.getMaxEntities());

        const reg = this.rpcs.registry as any;
        if (!reg.has(PING_RPC.method)) reg.register(PING_RPC);
        if (!reg.has(PONG_RPC.method)) reg.register(PONG_RPC);

        const tickRate = opts.loop.ticker.rate;
        const requestedSnapshotRate = opts.snapshot?.rate ?? Math.min(20, tickRate);
        const effectiveSnapshotRate = Math.min(requestedSnapshotRate, tickRate);
        this.snapshotEvery = Math.max(1, Math.round(tickRate / effectiveSnapshotRate));
        this.kickAckTimeout = opts.kick?.ackTimeout ?? 2000;
        this.reconnection = opts.reconnection ? { graceMs: opts.reconnection.graceMs ?? 10000 } : null;
        this.budgetBytes = opts.snapshot?.maxBytesPerPeer ?? 0;
        this.priorityFn = opts.snapshot?.priority ?? null;
        this.lastDt = opts.loop.ticker.intervalMs / 1000;

        this.discoverSyncedComponents();
        this.schemaFingerprint = opts.schemaFingerprint ?? computeSchemaFingerprint(this.syncedComponents);
        this.wireTransport();
        this.wireLoop();
    }

    private discoverSyncedComponents(): void {
        const all = this.world.getComponents() as Component<any>[];
        for (const c of all) {
            if (c.__sync !== undefined) this.syncedComponents.push(c);
        }
        this.syncedNumMaskWords = Math.max(1, Math.ceil(this.syncedComponents.length / 32));
        for (const c of this.syncedComponents) {
            const sync = (c as any).__sync as { quantize?: Record<string, { bits?: 8 | 16 }> } | undefined;
            const sizes = (c.fieldNames as string[]).map((f) => {
                const q = sync?.quantize?.[f];
                return q ? (q.bits ?? 16) / 8 : (c.schema as any)[f].size;
            });
            this.syncedWireSize.push(sizes);
        }
        this.encoder = new SnapshotEncoder(
            buildDeltaSchema(this.world, this.syncedComponents, this.syncedNumMaskWords),
        );
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
                intentSeqs: [],
                intentPayloads: [],
                visible: new SlotSet(this.world.getMaxEntities()),
                token: '',
                resolved: false,
                resumed: false,
                handshakeTimer: null,
            };
            this.peers.set(peerId, peer);
            peerTransport.onMessage((data) => this.handleIncoming(peer, data));
            peerTransport.onClose?.(() => this.handleDisconnect(peer, 'transport-closed'));
            this.log.info('peer connected', { peerId });
            {
                const fp = new TextEncoder().encode(this.schemaFingerprint);
                const frame = new Uint8Array(fp.length + 1);
                frame[0] = MSG_SCHEMA;
                frame.set(fp, 1);
                peerTransport.send(frame);
            }
            if (this.reconnection !== null) {
                peer.handshakeTimer = setTimeout(() => this.resolveHandshake(peer, ''), 250);
            } else {
                this.resolveHandshake(peer, '');
            }
        });

        this.transport.onDisconnection((peerId) => {
            const peer = this.peers.get(peerId);
            if (peer === undefined) return;
            this.handleDisconnect(peer, 'transport-closed');
        });
    }

    /**
     * Resolve the resume handshake. With a token matching a held session the
     * peer keeps its entity and ack cursor (`reconnection`); otherwise it is a
     * new peer (`connection`). Sends the client its session token either way.
     */
    private resolveHandshake(peer: InternalPeer, token: string): void {
        if (peer.resolved) return;
        peer.resolved = true;
        if (peer.handshakeTimer !== null) {
            clearTimeout(peer.handshakeTimer);
            peer.handshakeTimer = null;
        }

        const session = token !== '' ? this.sessions.get(token) : undefined;
        if (session !== undefined) {
            clearTimeout(session.timer);
            this.sessions.delete(token);
            peer.token = token;
            peer.resumed = true;
            peer.entity = session.entity;
            peer.lastAckedClientTick = session.lastAckedClientTick;
            peer.needsBaseline = true;
            peer.visible.clear();
            if (this.reconnection !== null) this.sendSession(peer);
            this.sendAssign(peer);
            this.log.info('peer reconnected', { peerId: peer.peerId, entity: peer.entity });
            this.emit('reconnection', { peer });
            return;
        }

        peer.token = `${this.sessionSalt}${this.nextSession++}`;
        peer.resumed = false;
        if (this.reconnection !== null) this.sendSession(peer);
        this.emit('connection', { peer });
    }

    private sendSession(peer: InternalPeer): void {
        const bytes = new TextEncoder().encode(peer.token);
        const frame = new Uint8Array(bytes.length + 2);
        frame[0] = MSG_SESSION;
        frame[1] = peer.resumed ? 1 : 0;
        frame.set(bytes, 2);
        peer.transport.send(frame);
    }

    private handleDisconnect(peer: InternalPeer, reason: string): void {
        if (!this.peers.has(peer.peerId)) return;
        if (peer.kicking !== null) clearTimeout(peer.kicking.timer);
        if (peer.handshakeTimer !== null) clearTimeout(peer.handshakeTimer);
        this.peers.delete(peer.peerId);
        for (const plugin of this.plugins) plugin.onDisconnect?.(peer);

        if (this.reconnection !== null && reason !== 'kicked' && peer.resolved && peer.entity !== -1) {
            const token = peer.token;
            const timer = setTimeout(() => {
                this.sessions.delete(token);
                this.log.info('peer reconnect timed out', { peerId: peer.peerId });
                this.emit('disconnection', { peer, reason: 'reconnect-timeout' });
            }, this.reconnection.graceMs);
            this.sessions.set(token, {
                entity: peer.entity,
                lastAckedClientTick: peer.lastAckedClientTick,
                timer,
            });
            this.log.info('peer suspended', { peerId: peer.peerId, reason });
            this.emit('suspended', { peer, reason });
            return;
        }

        this.log.info('peer disconnected', { peerId: peer.peerId, reason });
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
                peer.intentSeqs.length = 0;
                peer.intentPayloads.length = 0;
                peer.pendingBySequence.clear();
                return;
            }

            const seqs = peer.intentSeqs;
            const payloads = peer.intentPayloads;
            for (let i = 0; i < seqs.length; i++) {
                const seq = seqs[i]!;
                if (seq <= peer.lastAckedClientTick) continue;
                if (peer.pendingBySequence.has(seq)) continue;
                peer.pendingBySequence.set(seq, payloads[i]!);
            }
            seqs.length = 0;
            payloads.length = 0;

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
        this.dirtySeen.clear();
        this.scratch.length = 0;
        for (const c of this.syncedComponents) {
            this.world.forEachDirty(c, this.collectDirty);
        }

        const hadDespawn = this.world.getDespawned().length > 0;
        if (hadDespawn) this.world.flushDespawned();

        if (this.scratch.length === 0 && !hadDespawn && !this.anyNeedsBaseline()) {
            return;
        }
        this.retainDirty.clear();

        // Entities the spatial plugin does not cover (no position) ride along
        // unfiltered; collect them once, not per peer.
        this.passThrough.length = 0;
        if (this.nearbyPlugin !== null) {
            for (let i = 0; i < this.scratch.length; i++) {
                const eid = this.scratch[i]!;
                if (!this.nearbyPlugin.covers!(this.world, eid)) this.passThrough.push(eid);
            }
        }

        // Built lazily; only if at least one peer needs a baseline.
        let baseline: Entity[] | null = null;
        const computeBaseline = (): Entity[] => {
            if (baseline !== null) return baseline;
            const result: Entity[] = [];
            this.baselineSeen.clear();
            for (const c of this.syncedComponents) {
                for (const eid of this.world.query(c)) {
                    if (this.baselineSeen.add(eid)) result.push(eid);
                }
            }
            baseline = result;
            return result;
        };

        const peerOut: Entity[] = [];
        this.peers.forEach((peer) => {
            if (peer.kicking !== null) return;

            let source: ReadonlyArray<Entity>;
            if (this.nearbyPlugin !== null && !peer.needsBaseline) {
                // Spatial fast path: only entities near this peer (plus pass-through).
                const nearby = this.nearbyOut;
                nearby.length = 0;
                this.nearbyPlugin.nearby!(peer, this.world, nearby);
                for (let i = 0; i < this.passThrough.length; i++) nearby.push(this.passThrough[i]!);
                source = nearby;
            } else {
                source = peer.needsBaseline ? computeBaseline() : this.scratch;
            }

            // Candidates for interest: everything this peer saw last tick plus
            // the dirty set. Re-checking last tick's visible entities is what
            // lets a peer-driven AOI leave (entity still, peer moved) be caught.
            const candidates = this.candidates;
            candidates.length = 0;
            {
                const buf = peer.visible.denseBuffer;
                const n = peer.visible.size;
                for (let i = 0; i < n; i++) candidates.push(buf[i]!);
            }
            for (let i = 0; i < source.length; i++) candidates.push(source[i]!);

            // Per-plugin visible sets build lazily on first use this peer, via
            // this.interestAllows. `currentCandidates` feeds the plugins;
            // `currentPeer` feeds the reused encoder callback.
            this.interestBuilt = false;
            this.currentCandidates = candidates;
            this.currentPeer = peer;

            // Interest-visible entities this tick → the peer's new visibility set.
            const vis = this.visibleScratch;
            vis.clear();
            for (let i = 0; i < candidates.length; i++) {
                const eid = candidates[i]!;
                for (const c of this.syncedComponents) {
                    if (this.world.has(eid, c) && this.interestAllows(peer, eid, c)) { vis.add(eid); break; }
                }
            }

            // Entities the peer no longer sees (AOI leave, or a global despawn):
            // shipped as despawns so the client removes them.
            this.peerDespawned.length = 0;
            {
                const buf = peer.visible.denseBuffer;
                const n = peer.visible.size;
                for (let i = 0; i < n; i++) {
                    const eid = buf[i]!;
                    if (!vis.has(eid)) this.peerDespawned.push(eid);
                }
            }
            peer.visible.clear();
            {
                const buf = vis.denseBuffer;
                const n = vis.size;
                for (let i = 0; i < n; i++) peer.visible.add(buf[i]!);
            }
            if (this.peerDespawned.length > 0) {
                this.log.info('peer interest leave', { peerId: peer.peerId, count: this.peerDespawned.length });
            }

            // Entities with at least one component that ships to this peer.
            peerOut.length = 0;
            for (let i = 0; i < source.length; i++) {
                const eid = source[i]!;
                for (const c of this.syncedComponents) {
                    if (this.includeFor(peer, eid, c)) { peerOut.push(eid); break; }
                }
            }

            // Per-peer byte budget: keep the highest-priority entities that
            // fit; dropped ones stay dirty and ship on a later tick.
            if (this.budgetBytes > 0 && peerOut.length > 0) {
                const eids = this.budgetEids; eids.length = 0;
                const bytesArr = this.budgetBytesArr; bytesArr.length = 0;
                const pri = this.budgetPri; pri.length = 0;
                const order = this.budgetOrder; order.length = 0;
                for (let i = 0; i < peerOut.length; i++) {
                    const eid = peerOut[i]!;
                    eids.push(eid);
                    bytesArr.push(this.entityBytes(eid));
                    pri.push(this.priorityFn ? this.priorityFn(eid, this.world) : 0);
                    order.push(i);
                }
                order.sort(this.byPriDesc);
                let used = 0;
                peerOut.length = 0;
                for (let i = 0; i < order.length; i++) {
                    const idx = order[i]!;
                    const b = bytesArr[idx]!;
                    if (peerOut.length > 0 && used + b > this.budgetBytes) {
                        this.retainDirty.add(eids[idx]!);
                        continue;
                    }
                    used += b;
                    peerOut.push(eids[idx]!);
                }
            }

            // Baseline peers always send (even empty) so they get a tick
            // header + clientAckTick. Established peers skip empty deltas.
            if (peerOut.length === 0 && this.peerDespawned.length === 0 && !peer.needsBaseline) return;

            const frame = this.encoder.encode(
                this.world,
                this.tickCounter,
                peerOut as number[],
                this.peerDespawned,
                peer.lastAckedClientTick,
                this.encoderInclude,
            );
            frame[0] = MSG_SNAPSHOT;
            peer.transport.send(frame);

            peer.needsBaseline = false;
            this.emit('snapshot', { peer, tick: this.tickCounter, byteSize: frame.length });
        });

        // Clear dirty for the next tick. Per-peer ack-driven resend on
        // packet loss is future work.
        this.world.clearAllDirty();
        if (this.retainDirty.size > 0) {
            const rd = this.retainDirty.denseBuffer;
            const rn = this.retainDirty.size;
            for (let i = 0; i < rn; i++) {
                const eid = rd[i]!;
                for (const c of this.syncedComponents) {
                    if (this.world.has(eid, c)) this.world.markDirty(eid, (c as any).__worldIndex);
                }
            }
        this.retainDirty.clear();
        }
    }

    /** (Re)build the per-plugin visibility sets when the plugin list changes. */
    private ensureInterestSets(): void {
        if (this.interestSets.length === this.plugins.length) return;
        const max = this.world.getMaxEntities();
        this.interestSets = this.plugins.map(() => new SlotSet(max));
        this.interestIndex = Object.create(null);
        for (let i = 0; i < this.plugins.length; i++) this.interestIndex[this.plugins[i]!.name] = i;
    }

    /** Wire size (bytes) of one entity's shipping components for a peer. */
    /**
     * Whether the component's interest rule admits `eid` for `peer`. Per-plugin
     * visible sets are built once per peer, from `currentCandidates`.
     */
    private interestAllows(peer: InternalPeer, eid: Entity, c: Component<any>): boolean {
        const rule = (c.__sync as SyncSpec).interest;
        if (rule === 'global') return true;
        if (!this.interestBuilt) {
            this.ensureInterestSets();
            const out = this.interestOut;
            const candidates = this.currentCandidates!;
            for (let i = 0; i < this.plugins.length; i++) {
                const set = this.interestSets[i]!;
                set.clear();
                const plugin = this.plugins[i]!;
                if (plugin.filterSnapshot === undefined) continue;
                out.length = 0;
                plugin.filterSnapshot(peer, this.world, candidates, out);
                for (let k = 0; k < out.length; k++) set.add(out[k]!);
            }
            this.interestBuilt = true;
        }
        const idx = this.interestIndex[rule as string];
        return idx === undefined ? true : this.interestSets[idx]!.has(eid);
    }

    private includeFor(peer: InternalPeer, eid: Entity, c: Component<any>): boolean {
        return this.world.has(eid, c)
            && this.interestAllows(peer, eid, c)
            && (peer.needsBaseline
                || rateIncludes((c.__sync as SyncSpec).rate, this.world.isDirty(eid, c), this.tickCounter));
    }

    private entityBytes(eid: Entity): number {
        const include = this.encoderInclude;
        let bytes = 4 + this.syncedNumMaskWords * 4;
        for (let ci = 0; ci < this.syncedComponents.length; ci++) {
            const c = this.syncedComponents[ci]!;
            if (!this.world.has(eid, c) || !include(eid, c)) continue;
            const sizes = this.syncedWireSize[ci]!;
            for (let fi = 0; fi < sizes.length; fi++) bytes += sizes[fi]!;
        }
        return bytes;
    }

    private anyNeedsBaseline(): boolean {
        let any = false;
        this.peers.forEach((peer) => {
            if (peer.kicking === null && peer.needsBaseline) any = true;
        });
        return any;
    }

    private handleIncoming(peer: InternalPeer, data: Uint8Array): void {
        if (data.length === 0) return;
        const type = data[0];

        if (peer.kicking !== null) {
            // After kick: only KICK_ACK is processed.
            if (type === CMSG_KICK_ACK) this.completeKick(peer);
            return;
        }

        if (!peer.resolved) {
            if (type === CMSG_RESUME) {
                this.resolveHandshake(peer, new TextDecoder().decode(data.subarray(1)));
                return;
            }
            this.resolveHandshake(peer, '');
        }

        if (type === CMSG_INTENT) {
            if (data.length < 5) {
                this.emit('intent-failed', { peer, kind: -1, reason: 'decode-error' });
                return;
            }
            const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const sequence = dv.getUint32(1, true);
            peer.intentSeqs.push(sequence);
            peer.intentPayloads.push(data.subarray(5));
            return;
        }
        if (type === CMSG_RPC) {
            this.handleRpc(peer, data.subarray(1));
            return;
        }
        this.log.warn('unknown client message type', { type });
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
        if (typeof plugin.nearby === 'function' && typeof plugin.covers === 'function') {
            this.nearbyPlugin = plugin;
        }
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
        this.sendAssign(internal);
    }

    /** Frame: [MSG_ASSIGN_ENTITY][serverEntityId: u32] */
    private sendAssign(peer: InternalPeer): void {
        if (peer.entity === -1) return;
        const frame = new Uint8Array(1 + 4);
        frame[0] = MSG_ASSIGN_ENTITY;
        new DataView(frame.buffer).setUint32(1, peer.entity >>> 0, true);
        peer.transport.send(frame);
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
        this.peers.forEach((peer) => {
            if (peer.kicking !== null) return;
            this.sendRpc(peer, name, payload);
        });
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

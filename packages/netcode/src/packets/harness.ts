import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World, type Entity } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { SimpleRNG } from 'murow/core/simple-rng';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { definePredictions } from '../predictions/define-predictions';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';
import { networked } from '../components/sync-spec';
import type { Peer } from '../ctx';
import {
    JitterConfig,
    VirtualNetwork,
    VirtualServerTransport,
} from 'murow/net';

export const MOVE_SPEED = 4;
export const TICK_RATE = 24;
export const STEP_SEC = 1 / TICK_RATE + 0.001;
export const FIXED_DT = 1 / TICK_RATE;

export const Position = defineComponent('Position', {
    schema: { x: f32, z: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

export function buildSchema() {
    const intents = defineIntents({
        move: { dx: f32, dz: f32 },
    });
    const rpcs = defineRpcs({});
    const predictions = definePredictions(intents, {
        move: ({ dx, dz }, ctx) => {
            if (!ctx.world.has(ctx.entity, Position)) return;
            const pos = ctx.fields(Position);
            pos.x[ctx.entity] += dx * MOVE_SPEED * ctx.deltaTime;
            pos.z[ctx.entity] += dz * MOVE_SPEED * ctx.deltaTime;
        },
    });
    return { intents, rpcs, predictions };
}

export interface PeerSim {
    id: number;
    client: GameClient<any, any>;
    world: World;
    loop: GameLoop<'manual-client'>;
    peer: Peer;
    serverEntity: Entity;
    localEntity: Entity | null;
    dx: number;
    dz: number;
    sentIntents: number;
    serverAppliedIntents: number;
    reconciles: number;
    /** Largest correction magnitude observed across all reconciles. */
    maxCorrection: number;
    /** Largest replay depth observed across all reconciles. */
    maxReplayDepth: number;
    /** Total number of snapshots received. */
    snapshotsReceived: number;
    /** Snapshots whose tick was not strictly greater than the previous. */
    staleSnapshots: number;
    /** Highest snapshot tick observed. */
    lastSnapshotTick: number;
    /** Predicted position captured the moment a snapshot frame arrives. */
    _preReconcilePos: { x: number; z: number } | null;
}

export interface Harness {
    rng: SimpleRNG;
    vnet: VirtualNetwork;
    transport: VirtualServerTransport;
    serverLoop: GameLoop<'manual-server'>;
    serverWorld: World;
    server: GameServer<any, any>;
    sims: PeerSim[];
    serverIntentsByPeer: Map<string, number>;
}

export interface HarnessOptions {
    seed: number;
    numClients: number;
    jitter: JitterConfig;
    /** Override per-client unit movement direction. Defaults to evenly-spaced ring. */
    direction?: (i: number, n: number, rng: SimpleRNG) => { dx: number; dz: number };
    /** Override client GameClient options. */
    interpDelayMs?: number;
}

export function makeHarness(opts: HarnessOptions): Harness {
    const rng = new SimpleRNG(opts.seed);
    const vnet = new VirtualNetwork();
    const schema = buildSchema();

    const serverWorld = new World({ maxEntities: 128, components: [Position] });
    const serverLoop = new GameLoop({ tickRate: TICK_RATE, type: 'manual-server' });
    const transport = new VirtualServerTransport({ vnet, rng, cfg: opts.jitter });
    const server = new GameServer({
        world: serverWorld,
        loop: serverLoop,
        transport,
        protocol: { intents: schema.intents, rpcs: schema.rpcs },
        snapshot: { rate: TICK_RATE },
    });
    server.use(schema.predictions);

    const serverIntentsByPeer = new Map<string, number>();
    server.on('intent', ({ peer }) => {
        serverIntentsByPeer.set(peer.peerId, (serverIntentsByPeer.get(peer.peerId) ?? 0) + 1);
    });

    const sims: PeerSim[] = [];
    for (let i = 0; i < opts.numClients; i++) {
        const world = new World({ maxEntities: 128, components: [Position] });
        const loop = new GameLoop({ tickRate: TICK_RATE, type: 'manual-client' });
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world,
            loop,
            transport: clientTransport,
            protocol: { intents: schema.intents, rpcs: schema.rpcs },
            strategy: { kind: 'snapshot-interpolation', delay: opts.interpDelayMs ?? 100 },
            now: () => vnet.nowMs(),
        });
        client.use(schema.predictions);

        const peerIds = transport.getPeerIds();
        const peer: Peer = { peerId: peerIds[peerIds.length - 1], entity: -1 };
        const serverEntity = serverWorld.spawn();
        serverWorld.add(serverEntity, Position, { x: 0, z: 0 });
        server.assignEntity(peer, serverEntity);

        const dir = opts.direction
            ? opts.direction(i, opts.numClients, rng)
            : (() => {
                const a = (i / opts.numClients) * Math.PI * 2 + rng.range(-0.1, 0.1);
                return { dx: Math.cos(a), dz: Math.sin(a) };
            })();

        const sim: PeerSim = {
            id: i,
            client,
            world,
            loop,
            peer,
            serverEntity,
            localEntity: null,
            dx: dir.dx,
            dz: dir.dz,
            sentIntents: 0,
            serverAppliedIntents: 0,
            reconciles: 0,
            maxCorrection: 0,
            maxReplayDepth: 0,
            snapshotsReceived: 0,
            staleSnapshots: 0,
            lastSnapshotTick: 0,
            _preReconcilePos: null,
        };

        client.on('assigned', ({ entity }) => {
            sim.localEntity = entity;
        });

        // 'snapshot' fires after decode but before reconcile runs, which
        // is exactly the window where the predicted entity is still at
        // its pre-rewind position. Use it instead of byte-sniffing.
        client.on('snapshot', ({ tick }) => {
            sim.snapshotsReceived++;
            if (tick <= sim.lastSnapshotTick) sim.staleSnapshots++;
            else sim.lastSnapshotTick = tick;
            if (sim.localEntity !== null) {
                const p = world.get(sim.localEntity, Position);
                sim._preReconcilePos = { x: p.x, z: p.z };
            }
        });

        client.on('reconciled', ({ replayed }) => {
            sim.reconciles++;
            if (replayed > sim.maxReplayDepth) sim.maxReplayDepth = replayed;
            if (sim.localEntity === null || sim._preReconcilePos === null) return;
            const p = world.get(sim.localEntity, Position);
            const correction = Math.hypot(
                p.x - sim._preReconcilePos.x,
                p.z - sim._preReconcilePos.z,
            );
            if (correction > sim.maxCorrection) sim.maxCorrection = correction;
            sim._preReconcilePos = null;
        });

        sims.push(sim);
    }

    return { rng, vnet, transport, serverLoop, serverWorld, server, sims, serverIntentsByPeer };
}

/**
 * Run a no-loss bootstrap so every client receives its assignment, then
 * (optionally) flip back to the jittery config for steady-state traffic.
 * `bootstrap` defaults to "same config but lossChance=0".
 *
 * If `warmupTicks` is set, each client steps a random number of ticks in
 * [0, warmupTicks] BEFORE the main scenario, so clients enter with
 * different `localTick` values (simulating staggered join times).
 */
export function bootstrap(
    h: Harness,
    steadyState: JitterConfig,
    opts: { warmupTicks?: number } = {},
): void {
    const bootCfg: JitterConfig = { ...steadyState, lossChance: 0 };
    h.transport.setConfig(bootCfg);
    h.serverLoop.step(STEP_SEC);
    h.vnet.advance(300);
    for (const sim of h.sims) sim.loop.step(STEP_SEC);
    h.vnet.advance(300);

    if (opts.warmupTicks && opts.warmupTicks > 0) {
        for (const sim of h.sims) {
            const extra = h.rng.int(0, opts.warmupTicks);
            for (let k = 0; k < extra; k++) sim.loop.step(STEP_SEC);
        }
        h.vnet.advance(100);
    }

    h.transport.setConfig(steadyState);
}

/** Drain pending packets with loss disabled so post-conditions can settle. */
export function drain(h: Harness, jitter: JitterConfig, ticks = 32): void {
    const lossless: JitterConfig = { ...jitter, lossChance: 0 };
    h.transport.setConfig(lossless);
    for (let k = 0; k < ticks; k++) {
        h.vnet.advance(50);
        h.serverLoop.step(STEP_SEC);
        h.vnet.advance(50);
    }
    h.vnet.advance(1000);
}

/** Snapshot per-peer server-applied intent counts into each sim. */
export function captureServerCounts(h: Harness): void {
    for (const sim of h.sims) {
        sim.serverAppliedIntents = h.serverIntentsByPeer.get(sim.peer.peerId) ?? 0;
    }
}

/** FNV-1a 32-bit hash over Position fields. Determinism probe. */
export function hashPositions(world: World, entities: Entity[]): number {
    let h = 0x811c9dc5;
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    for (const e of entities) {
        if (!world.has(e, Position)) continue;
        const pos = world.get(e, Position);
        view.setFloat32(0, pos.x, true);
        view.setFloat32(4, pos.z, true);
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    }
    return h >>> 0;
}

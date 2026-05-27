import { describe, test, expect } from 'bun:test';
import { f32, u16 } from 'murow/core/binary-codec';
import { defineComponent, World, type Entity } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { defineIntents } from './intents/define-intents';
import { defineRpcs } from './rpcs/define-rpcs';
import { definePredictions } from './predictions/define-predictions';
import { defineHandlers } from './handlers/define-handlers';
import { GameServer } from './server/game-server';
import { GameClient } from './client/game-client';
import { MemoryServerTransport } from './transports/memory-transport';
import type { ServerEventPayloads, ClientEventPayloads } from './network/base';
import type { Peer } from './ctx';
import { networked } from './components/sync-spec';

/**
 * Drain pending microtasks. `queueMicrotask` runs eagerly inside a single
 * `await Promise.resolve()` step in Bun, so one flush is enough — the
 * extra iterations are belt-and-braces for any future transport that
 * chains microtasks.
 */
async function flush(): Promise<void> {
    for (let i = 0; i < 2; i++) await Promise.resolve();
}

/** Small typed capture helper — records the last event payload of type T. */
function capture<T>(): { value: T | null; set: (e: T) => void } {
    const box: { value: T | null; set: (e: T) => void } = {
        value: null,
        set: (e: T) => { box.value = e; },
    };
    return box;
}

/** Records every payload of type T into an array. */
function captureAll<T>(): { values: T[]; push: (e: T) => void } {
    const arr: T[] = [];
    return { values: arr, push: (e: T) => { arr.push(e); } };
}

const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global' }),
});
const Velocity = defineComponent('Velocity', {
    schema: { vx: f32, vy: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global' }),
});
const Health = defineComponent('Health', {
    schema: { hp: u16 },
    sync: networked({ rate: 'on-change', interest: 'global' }),
});

const ATTACK_DAMAGE = 25;

function defineSchemas() {
    const intents = defineIntents({
        move: { dx: f32, dy: f32 },
        attack: { targetId: u16 },
    });
    const rpcs = defineRpcs({
        countdown: { secondsRemaining: u16 },
    });
    const predictions = definePredictions(intents, {
        move: ({ dx, dy }, ctx) => {
            if (ctx.world.has(ctx.entity, Velocity)) {
                ctx.world.update(ctx.entity, Velocity, { vx: dx, vy: dy });
            }
        },
    });
    const handlers = defineHandlers(intents, {
        attack: ({ targetId }, ctx) => {
            if (!ctx.world.has(targetId, Health)) return;
            const current = ctx.world.get(targetId, Health);
            const nextHp = Math.max(0, current.hp - ATTACK_DAMAGE);
            ctx.world.update(targetId, Health, { hp: nextHp });
        },
    });
    return { intents, rpcs, predictions, handlers };
}

/**
 * Set up a server (and the shared schema bundle). Tests that want fast
 * snapshots for assertion convenience pass `snapshotEveryTick: true`; tests
 * that exercise snapshot batching can pass `false` or omit.
 */
function setupServer(opts?: { snapshotEveryTick?: boolean }) {
    const schemas = defineSchemas();
    const serverWorld = new World({ maxEntities: 64, components: [Position, Velocity, Health] });
    const serverLoop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    const transport = new MemoryServerTransport();
    const server = new GameServer({
        world: serverWorld,
        loop: serverLoop,
        transport,
        protocol: { intents: schemas.intents, rpcs: schemas.rpcs },
        snapshot: opts?.snapshotEveryTick === false ? undefined : { rate: 60 },
    });
    server.use(schemas.predictions);
    server.use(schemas.handlers);

    return { ...schemas, serverWorld, serverLoop, transport, server };
}

/**
 * Connect one client to a running server. Returns the GameClient, the
 * client-side World, and the Peer record the server now sees.
 */
function connectClient(
    ctx: ReturnType<typeof setupServer>,
    opts?: { useDefaultPredictions?: boolean },
): {
    client: GameClient<ReturnType<typeof defineSchemas>['intents']['__payloads'] extends infer X ? any : never, any>;
    clientWorld: World;
    clientLoop: GameLoop<any>;
    peer: Peer;
} {
    const clientWorld = new World({ maxEntities: 64, components: [Position, Velocity, Health] });
    const clientLoop = new GameLoop({ tickRate: 60, type: 'manual-client' });
    const { client: clientTransport } = ctx.transport.connectClient();
    const client = new GameClient({
        world: clientWorld,
        loop: clientLoop,
        transport: clientTransport,
        protocol: { intents: ctx.intents, rpcs: ctx.rpcs },
        // Tests assert World state immediately after a snapshot tick.
        // delay=0 makes the interpolation buffer emit the newest value
        // on the next 'sync' phase rather than rendering 100ms behind.
        strategy: { kind: 'snapshot-interpolation', delay: 0 },
    });
    if (opts?.useDefaultPredictions !== false) client.use(ctx.predictions);

    // Find the matching peer record on the server.
    const peerIds = ctx.transport.getPeerIds();
    const peerId = peerIds[peerIds.length - 1];
    const peer: Peer = { peerId, entity: -1 };

    return { client, clientWorld, clientLoop, peer };
}

describe('multiplayer end-to-end', () => {
    test('connection event fires with a typed peer payload', async () => {
        const ctx = setupServer();
        const seen = capture<ServerEventPayloads['connection']>();
        ctx.server.on('connection', seen.set);

        ctx.transport.connectClient();

        expect(seen.value).not.toBeNull();
        expect(seen.value!.peer.peerId).toMatch(/^peer_/);
    });

    test('snapshot arrives, entity is spawned locally with the right components', async () => {
        const ctx = setupServer();
        const serverEntity = ctx.serverWorld.spawn();
        ctx.serverWorld.add(serverEntity, Position, { x: 100, y: 200 });
        ctx.serverWorld.add(serverEntity, Velocity, { vx: 0, vy: 0 });

        const { client, clientWorld, clientLoop } = connectClient(ctx);

        const spawned = capture<ClientEventPayloads['spawn']>();
        client.on('spawn', spawned.set);
        const snap = capture<ClientEventPayloads['snapshot']>();
        client.on('snapshot', snap.set);

        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        // Drive the client loop so the interpolation buffer's 'sync' phase
        // flushes the freshly recorded snapshot into the client World.
        clientLoop.step(1 / 60 + 0.001);

        expect(snap.value).not.toBeNull();
        expect(spawned.value).not.toBeNull();
        expect(typeof spawned.value!.entity).toBe('number');
        const pos = clientWorld.get(spawned.value!.entity, Position);
        expect(pos.x).toBeCloseTo(100);
        expect(pos.y).toBeCloseTo(200);
    });

    test('updates to an entity flow through subsequent snapshots', async () => {
        const ctx = setupServer();
        const e = ctx.serverWorld.spawn();
        ctx.serverWorld.add(e, Position, { x: 0, y: 0 });
        ctx.serverWorld.add(e, Velocity, { vx: 0, vy: 0 });

        const { client, clientWorld, clientLoop } = connectClient(ctx);
        const spawned = capture<ClientEventPayloads['spawn']>();
        client.on('spawn', spawned.set);
        await flush();

        // First snapshot — spawn flows to client.
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);
        expect(spawned.value).not.toBeNull();
        const localE = spawned.value!.entity;
        expect(clientWorld.get(localE, Position).x).toBeCloseTo(0);

        // Server mutates the position; the next snapshot tick should deliver it.
        ctx.serverWorld.update(e, Position, { x: 42, y: -7 });
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        const updated = clientWorld.get(localE, Position);
        expect(updated.x).toBeCloseTo(42);
        expect(updated.y).toBeCloseTo(-7);
    });

    test('client.sendIntent triggers a typed server intent event', async () => {
        const ctx = setupServer();
        const { client, peer, clientLoop } = connectClient(ctx);

        const seen = capture<ServerEventPayloads['intent']>();
        ctx.server.on('intent', seen.set);
        await flush();

        // Assign + sync so the client can resolve its assignment and sendIntent unblocks.
        const serverEntity = ctx.serverWorld.spawn();
        ctx.serverWorld.add(serverEntity, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, serverEntity);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        client.sendIntent('move', { dx: 2, dy: -3 });
        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        expect(seen.value).not.toBeNull();
        expect(seen.value!.name).toBe('move');
        const payload = seen.value!.payload as { dx: number; dy: number };
        expect(payload.dx).toBeCloseTo(2);
        expect(payload.dy).toBeCloseTo(-3);
    });

    test('intent-failed fires when the server receives a malformed intent frame', async () => {
        const ctx = setupServer();
        const { peer } = connectClient(ctx);
        await flush();

        const failures = captureAll<ServerEventPayloads['intent-failed']>();
        ctx.server.on('intent-failed', failures.push);

        // Inject a malformed payload through the raw transport.
        const peerTransport = ctx.transport.getPeer(peer.peerId)!;
        // Frame: [CMSG_INTENT=0x01, kind=0xff (unknown)] — registry rejects.
        const malformed = new Uint8Array([0x01, 0xff]);
        // The server's onMessage handler was registered on the peer
        // transport's "server-side" channel — emit by simulating a client
        // send through the same memory pipe.
        const peerView = (peerTransport as any).clientView() as { send: (data: Uint8Array) => void };
        peerView.send(malformed);
        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        expect(failures.values.length).toBe(1);
        expect(failures.values[0].reason).toMatch(/decode|unknown/);
    });

    test('sendIntent applies prediction locally on the assigned entity; prediction depth grows', async () => {
        const ctx = setupServer();
        const { client, clientWorld, peer, clientLoop } = connectClient(ctx);

        // Server creates and assigns the predicted entity, ships it.
        const serverEntity = ctx.serverWorld.spawn();
        ctx.serverWorld.add(serverEntity, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, serverEntity);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        const localEntity = (client as any).serverToLocal.get(serverEntity) as number;

        // sendIntent defaults ctx.entity to the assigned entity.
        client.sendIntent('move', { dx: 5, dy: 7 });
        const v = clientWorld.get(localEntity, Velocity);
        expect(v.vx).toBeCloseTo(5);
        expect(v.vy).toBeCloseTo(7);
        expect(client.getPredictionDepth()).toBe(1);
    });

    test('reconciliation: predictions older than snapshot are dropped, newer ones are replayed', async () => {
        const ctx = setupServer();
        const { client, peer, clientLoop } = connectClient(ctx);
        await flush();

        // Spawn + assign the entity so the client has an assigned entity
        // to predict against. client.localTick is 0 at this point.
        const serverEntity = ctx.serverWorld.spawn();
        ctx.serverWorld.add(serverEntity, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, serverEntity);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        // Advance localTick so it's > the snapshot's serverTick.
        clientLoop.step(1 / 60 + 0.001);
        clientLoop.step(1 / 60 + 0.001);
        clientLoop.step(1 / 60 + 0.001);

        client.sendIntent('move', { dx: 9, dy: 0 });
        expect(client.getPredictionDepth()).toBe(1);
        const sequenceAtPredict = 1;

        const reconciled = captureAll<ClientEventPayloads['reconciled']>();
        client.on('reconciled', reconciled.push);

        const localEid = client.assignedEntity!;
        const serverEid = [...(client as any).serverToLocal.entries()]
            .find(([, lid]) => lid === localEid)![0] as number;
        const stubDelta = (clientAckTick: number) => ({
            tick: 0,
            clientAckTick,
            entityIds: [localEid],
            serverEntityIds: [serverEid],
            despawnedServerIds: [] as number[],
            valuesByServerEntity: new Map([[serverEid, new Map([[Velocity, { vx: 0, vy: 0 }]])]]),
        });

        (client as any).reconcile(stubDelta(sequenceAtPredict - 1));
        expect(client.getPredictionDepth()).toBe(1);
        expect(reconciled.values.length).toBe(1);
        expect(reconciled.values[0].replayed).toBe(1);

        (client as any).reconcile(stubDelta(sequenceAtPredict));
        expect(client.getPredictionDepth()).toBe(0);
        expect(reconciled.values.length).toBe(2);
        expect(reconciled.values[1].replayed).toBe(0);
    });

    test('broadcastRpc fans out to every connected client', async () => {
        const ctx = setupServer();
        const { client: a } = connectClient(ctx);
        const { client: b } = connectClient(ctx);

        const aGot = capture<ClientEventPayloads['rpc']>();
        const bGot = capture<ClientEventPayloads['rpc']>();
        a.on('rpc', aGot.set);
        b.on('rpc', bGot.set);
        await flush();

        ctx.server.broadcastRpc('countdown', { secondsRemaining: 3 });
        await flush();

        expect(aGot.value).not.toBeNull();
        expect(bGot.value).not.toBeNull();
        expect(aGot.value!.name).toBe('countdown');
        expect((aGot.value!.payload as { secondsRemaining: number }).secondsRemaining).toBe(3);
        expect((bGot.value!.payload as { secondsRemaining: number }).secondsRemaining).toBe(3);
    });

    test('sendRpc to a single peer reaches only that peer', async () => {
        const ctx = setupServer();
        const { client: a, peer: peerA } = connectClient(ctx);
        const { client: b } = connectClient(ctx);

        const aGot = captureAll<ClientEventPayloads['rpc']>();
        const bGot = captureAll<ClientEventPayloads['rpc']>();
        a.on('rpc', aGot.push);
        b.on('rpc', bGot.push);
        await flush();

        ctx.server.sendRpc(peerA, 'countdown', { secondsRemaining: 9 });
        await flush();

        expect(aGot.values.length).toBe(1);
        expect(bGot.values.length).toBe(0);
    });

    test('kick flow: client receives a typed kicked event, then disconnected', async () => {
        const ctx = setupServer();
        const { client, peer } = connectClient(ctx);

        const kicked = capture<ClientEventPayloads['kicked']>();
        client.on('kicked', kicked.set);
        const disconnectedClient = capture<ClientEventPayloads['disconnected']>();
        client.on('disconnected', disconnectedClient.set);
        const disconnectedServer = capture<ServerEventPayloads['disconnection']>();
        ctx.server.on('disconnection', disconnectedServer.set);
        await flush();

        ctx.server.kick(peer, 'banned');
        await flush();
        await flush();

        expect(kicked.value).not.toBeNull();
        expect(kicked.value!.reason).toBe('banned');
        expect(disconnectedServer.value).not.toBeNull();
        expect(disconnectedServer.value!.reason).toBe('kicked');
        expect(disconnectedClient.value).not.toBeNull();
    });

    test('client-initiated disconnect fires disconnection on server with transport-closed reason', async () => {
        const ctx = setupServer();
        const { client, peer } = connectClient(ctx);

        const serverDisc = capture<ServerEventPayloads['disconnection']>();
        ctx.server.on('disconnection', serverDisc.set);
        await flush();

        // Close the transport from the client side (simulates the user
        // calling client.disconnect or a network drop).
        const peerTransport = ctx.transport.getPeer(peer.peerId)!;
        // Use the client-facing view of the transport to close.
        (peerTransport as any).clientView().close();
        await flush();

        expect(serverDisc.value).not.toBeNull();
        expect(serverDisc.value!.reason).toBe('transport-closed');
    });

    test('sendIntent defaults ctx.entity to the server-assigned entity (no opts.entity needed)', async () => {
        const ctx = setupServer();
        const { client, peer, clientLoop, clientWorld } = connectClient(ctx);
        const assigned = capture<ClientEventPayloads['assigned']>();
        client.on('assigned', assigned.set);
        await flush();

        // Server creates and assigns the entity, syncs it via a snapshot.
        const e = ctx.serverWorld.spawn();
        ctx.serverWorld.add(e, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, e);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);
        expect(assigned.value).not.toBeNull();
        const localE = assigned.value!.entity;

        // sendIntent with NO entity opt — should default to the assigned
        // entity and run the prediction against it.
        client.sendIntent('move', { dx: 11, dy: -3 });

        const v = clientWorld.get(localE, Velocity);
        expect(v.vx).toBeCloseTo(11);
        expect(v.vy).toBeCloseTo(-3);
    });

    test('server.assignEntity surfaces as an "assigned" event on the client with the local entity id', async () => {
        const ctx = setupServer();
        const { client, peer, clientLoop, clientWorld } = connectClient(ctx);
        const assigned = capture<ClientEventPayloads['assigned']>();
        client.on('assigned', assigned.set);
        await flush();

        // Server spawns an entity, syncs it through a snapshot first so
        // the client already knows about it locally, then assigns it.
        const e = ctx.serverWorld.spawn();
        ctx.serverWorld.add(e, Position, { x: 1, y: 2 });
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        ctx.server.assignEntity(peer, e);
        await flush();

        expect(assigned.value).not.toBeNull();
        const localE = assigned.value!.entity;
        expect(clientWorld.isAlive(localE)).toBe(true);
        // The client should treat this entity as predicted, so the
        // interpolation buffer leaves it alone.
        expect((client as any).predictedEntities.has(localE)).toBe(true);
    });

    test('assignEntity arriving before the entity exists locally resolves once the spawn lands', async () => {
        const ctx = setupServer();
        const { client, peer, clientLoop } = connectClient(ctx);
        const assigned = capture<ClientEventPayloads['assigned']>();
        client.on('assigned', assigned.set);
        await flush();

        // Assign before any snapshot has carried the entity to the client.
        const e = ctx.serverWorld.spawn();
        ctx.serverWorld.add(e, Position, { x: 0, y: 0 });
        ctx.server.assignEntity(peer, e);
        await flush();

        // Assignment buffered — entity isn't known locally yet.
        expect(assigned.value).toBeNull();

        // Snapshot delivers the entity. Buffered assignment resolves now.
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        expect(assigned.value).not.toBeNull();
    });

    test('assignEntity makes ctx.entity available to subsequent intent handlers', async () => {
        const ctx = setupServer();
        const { client, peer, clientLoop } = connectClient(ctx);
        await flush();

        // Spawn a server-side entity, sync it through a snapshot so the
        // client knows about it, then assign so client.sendIntent unblocks.
        const e = ctx.serverWorld.spawn();
        ctx.serverWorld.add(e, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, e);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        client.sendIntent('move', { dx: 4, dy: 5 });
        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        // The server's move prediction wrote to Velocity on ctx.entity.
        // ctx.entity was filled from the assigned peer.entity.
        const v = ctx.serverWorld.get(e, Velocity);
        expect(v.vx).toBeCloseTo(4);
        expect(v.vy).toBeCloseTo(5);
    });

    test('server-only handler applies damage authoritatively, client world is untouched', async () => {
        const ctx = setupServer();
        const target = ctx.serverWorld.spawn();
        ctx.serverWorld.add(target, Health, { hp: 100 });

        const { client, clientWorld, clientLoop, peer } = connectClient(ctx);
        await flush();

        // Assign + sync so the client can resolve its assignment and sendIntent unblocks.
        const attacker = ctx.serverWorld.spawn();
        ctx.serverWorld.add(attacker, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, attacker);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        expect(ctx.serverWorld.get(target, Health).hp).toBe(100);

        client.sendIntent('attack', { targetId: target as Entity });
        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        expect(ctx.serverWorld.get(target, Health).hp).toBe(75);
        // Prediction map has no 'attack' entry — the client never mutated locally.
        expect(clientWorld.has(target, Health)).toBe(false);
    });

    test('repeated attacks accumulate damage', async () => {
        const ctx = setupServer();
        const target = ctx.serverWorld.spawn();
        ctx.serverWorld.add(target, Health, { hp: 100 });

        const { client, clientLoop, peer } = connectClient(ctx);
        await flush();

        const attacker = ctx.serverWorld.spawn();
        ctx.serverWorld.add(attacker, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, attacker);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        for (let i = 0; i < 3; i++) {
            client.sendIntent('attack', { targetId: target as Entity });
            await flush();
            ctx.serverLoop.step(1 / 60 + 0.001);
            await flush();
        }
        expect(ctx.serverWorld.get(target, Health).hp).toBe(25);
    });

    test('damage clamps to zero, not negative', async () => {
        const ctx = setupServer();
        const target = ctx.serverWorld.spawn();
        ctx.serverWorld.add(target, Health, { hp: 30 });

        const { client, clientLoop, peer } = connectClient(ctx);
        await flush();

        const attacker = ctx.serverWorld.spawn();
        ctx.serverWorld.add(attacker, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, attacker);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        client.sendIntent('attack', { targetId: target as Entity });
        client.sendIntent('attack', { targetId: target as Entity });
        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        expect(ctx.serverWorld.get(target, Health).hp).toBe(0);
    });

    test('newcomer receives a baseline snapshot of existing idle entities', async () => {
        const ctx = setupServer();

        // Pre-existing entity, mutated before any client connects. Server
        // ticks once so its dirty bits get sent (to nobody) and cleared.
        const e = ctx.serverWorld.spawn();
        ctx.serverWorld.add(e, Position, { x: 7, y: 11 });
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        // Now a client connects. The pre-existing entity hasn't been
        // mutated this tick, so the dirty union is empty — without
        // baseline support, the newcomer would never see it.
        const { client, clientWorld, clientLoop } = connectClient(ctx);
        const spawned = capture<ClientEventPayloads['spawn']>();
        client.on('spawn', spawned.set);
        await flush();

        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        expect(spawned.value).not.toBeNull();
        const localE = spawned.value!.entity;
        const pos = clientWorld.get(localE, Position);
        expect(pos.x).toBeCloseTo(7);
        expect(pos.y).toBeCloseTo(11);
    });

    test('attack against a target without Health is a no-op (engine path still fires intent)', async () => {
        const ctx = setupServer();
        const target = ctx.serverWorld.spawn();

        const { client, clientLoop, peer } = connectClient(ctx);
        const intentEvent = capture<ServerEventPayloads['intent']>();
        ctx.server.on('intent', intentEvent.set);
        await flush();

        const attacker = ctx.serverWorld.spawn();
        ctx.serverWorld.add(attacker, Velocity, { vx: 0, vy: 0 });
        ctx.server.assignEntity(peer, attacker);
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);

        client.sendIntent('attack', { targetId: target as Entity });
        await flush();
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();

        expect(intentEvent.value).not.toBeNull();
        expect(intentEvent.value!.name).toBe('attack');
        expect(ctx.serverWorld.has(target, Health)).toBe(false);
    });

    test('client.ping round-trips and fires pong with the measured rtt', async () => {
        const ctx = setupServer();
        const { client } = connectClient(ctx);
        await flush();

        const pongSeen = capture<ClientEventPayloads['pong']>();
        client.on('pong', pongSeen.set);

        client.ping();
        await flush();

        expect(pongSeen.value).not.toBeNull();
        expect(typeof pongSeen.value!.rtt).toBe('number');
        expect(pongSeen.value!.rtt).toBeGreaterThanOrEqual(0);
        expect(pongSeen.value!.rtt).toBeLessThan(0x10000);
        expect(client.rttMs).toBe(pongSeen.value!.rtt);
    });
});

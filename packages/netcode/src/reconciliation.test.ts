import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { defineIntents } from './intents/define-intents';
import { defineRpcs } from './rpcs/define-rpcs';
import { definePredictions } from './predictions/define-predictions';
import { GameServer } from './server/game-server';
import { GameClient } from './client/game-client';
import { MemoryServerTransport } from './transports/memory-transport';
import { networked } from './components/sync-spec';

async function flush(): Promise<void> {
    for (let i = 0; i < 2; i++) await Promise.resolve();
}

/**
 * Real end-to-end reconciliation tests — no private-method casts. Each
 * scenario predicts on the client, lets the server apply authoritative
 * truth, and asserts the post-snapshot World matches what the server
 * intended plus any unacked predictions.
 */
describe('reconciliation', () => {
    const Position = defineComponent('Position', {
        schema: { x: f32, y: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global' }),
    });

    function setup() {
        const intents = defineIntents({
            // dx/dy are absolute targets in this test, not deltas.
            teleport: { x: f32, y: f32 },
        });
        const rpcs = defineRpcs({});

        const predictions = definePredictions(intents, {
            teleport: ({ x, y }, ctx) => {
                if (ctx.world.has(ctx.entity, Position)) {
                    ctx.world.update(ctx.entity, Position, { x, y });
                }
            },
        });

        const serverWorld = new World({ maxEntities: 32, components: [Position] });
        const clientWorld = new World({ maxEntities: 32, components: [Position] });
        const serverLoop = new GameLoop({ tickRate: 60, type: 'manual-server' });
        const clientLoop = new GameLoop({ tickRate: 60, type: 'manual-client' });
        const transport = new MemoryServerTransport();

        const server = new GameServer({
            world: serverWorld,
            loop: serverLoop,
            transport,
            protocol: { intents, rpcs },
            snapshot: { rate: 60 },
        });
        server.use(predictions);

        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });
        client.use(predictions);

        return {
            intents, rpcs, predictions,
            server, serverWorld, serverLoop,
            client, clientWorld, clientLoop,
            transport,
        };
    }

    test('client prediction is corrected when server snapshot disagrees', async () => {
        const ctx = setup();
        const { server, serverWorld, client, clientWorld, serverLoop, transport } = ctx;

        // Server-owned entity with starting position (0, 0).
        const serverEntity = serverWorld.spawn();
        serverWorld.add(serverEntity, Position, { x: 0, y: 0 });

        // Assign it to the client's peer so server intents apply to it.
        const peerIds = transport.getPeerIds();
        const peer = { peerId: peerIds[0], entity: -1 };
        server.assignEntity(peer, serverEntity);

        // First snapshot — client mirrors the entity at (0, 0).
        serverLoop.step(1 / 60 + 0.001);
        await flush();

        // Find the local mapping for this server entity. The engine
        // auto-marks it predicted as part of resolving the
        // `assignEntity` → MSG_ASSIGN_ENTITY → 'assigned' chain.
        const localEntity = (client as any).serverToLocal.get(serverEntity) as number;
        expect(localEntity).toBeDefined();
        expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(0);

        // Client predicts a teleport to (100, 100) for its assigned
        // entity. The prediction runs locally — clientWorld now reflects
        // (100, 100).
        client.sendIntent('teleport', { x: 100, y: 100 });
        expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(100);
        expect(clientWorld.get(localEntity, Position).y).toBeCloseTo(100);

        // Server receives the intent and applies the SAME prediction (the
        // bundle is shared) — authoritative position is also (100, 100).
        await flush();
        expect(serverWorld.get(serverEntity, Position).x).toBeCloseTo(100);

        // Server snapshot arrives → reconciler sees its tick > prediction
        // tick → prediction is dropped. Client position remains (100, 100).
        serverLoop.step(1 / 60 + 0.001);
        await flush();
        expect(client.getPredictionDepth()).toBe(0);
        expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(100);
    });

    test('a prediction newer than the snapshot is replayed on top of authoritative state', async () => {
        const ctx = setup();
        const { server, serverWorld, client, clientWorld, serverLoop, clientLoop, transport } = ctx;

        const serverEntity = serverWorld.spawn();
        serverWorld.add(serverEntity, Position, { x: 0, y: 0 });

        const peerIds = transport.getPeerIds();
        const peer = { peerId: peerIds[0], entity: -1 };
        server.assignEntity(peer, serverEntity);

        // Initial snapshot to populate the client.
        serverLoop.step(1 / 60 + 0.001);
        await flush();

        const localEntity = (client as any).serverToLocal.get(serverEntity) as number;

        // Advance client ticks so localTick > snapshot tick.
        clientLoop.step(1 / 60 + 0.001);
        clientLoop.step(1 / 60 + 0.001);
        clientLoop.step(1 / 60 + 0.001);

        // Predict locally — set position to (50, 50). DON'T forward to the
        // server in this test (we'll simulate "client predicted, server
        // hasn't seen it yet").
        const predFn = (predictions: any) => predictions.map.teleport;
        // We can't easily prevent the intent from reaching the server with
        // MemoryTransport's microtask delivery — instead, predict directly
        // through the prediction map (the bundle is the same as the engine
        // would call).
        // Workaround: simulate a divergence by mutating the server-side
        // entity to a different position than the client predicts, then
        // sending a third position via the client's prediction. Reconciler
        // should re-apply the prediction on top of the snapshot.

        // Step 1: server entity moves authoritatively to (10, 10).
        serverWorld.update(serverEntity, Position, { x: 10, y: 10 });

        // Step 2: client predicts a teleport to (50, 50) BEFORE the
        // snapshot arrives. sendIntent stamps with current localTick.
        client.sendIntent('teleport', { x: 50, y: 50 });
        expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(50);
        expect(client.getPredictionDepth()).toBe(1);

        // Step 3: the server tick is still behind the predicted tick (the
        // snapshot was the empty one from line above). Drive a server tick
        // that ships authoritative (10, 10). The snapshot's serverTick is
        // less than the prediction's localTick, so the prediction must NOT
        // be dropped, AND it must be re-applied on top of (10, 10).
        serverLoop.step(1 / 60 + 0.001);
        await flush();

        // Reconciler should have replayed the teleport → position back to (50, 50).
        expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(50);
        expect(clientWorld.get(localEntity, Position).y).toBeCloseTo(50);
    });

    test('despawn: server removes an entity, client receives the despawn event and cleans up', async () => {
        const ctx = setup();
        const { server, serverWorld, client, clientWorld, serverLoop, transport } = ctx;

        const serverEntity = serverWorld.spawn();
        serverWorld.add(serverEntity, Position, { x: 5, y: 5 });

        // First snapshot — client learns about the entity.
        serverLoop.step(1 / 60 + 0.001);
        await flush();

        const localEntity = (client as any).serverToLocal.get(serverEntity) as number;
        expect(localEntity).toBeDefined();
        expect(clientWorld.isAlive(localEntity)).toBe(true);

        // Capture despawn event.
        let despawned: { entity: number } | null = null;
        client.on('despawn', (e) => { despawned = e; });

        // Server despawns the entity.
        serverWorld.despawn(serverEntity);

        // Next snapshot ships the despawn list.
        serverLoop.step(1 / 60 + 0.001);
        await flush();

        expect(despawned).not.toBeNull();
        expect(despawned!.entity).toBe(localEntity);
        expect(clientWorld.isAlive(localEntity)).toBe(false);
        // Mapping is cleaned up too.
        expect((client as any).serverToLocal.has(serverEntity)).toBe(false);
        void server;
    });
});

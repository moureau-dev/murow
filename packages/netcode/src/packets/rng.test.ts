import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { SimpleRNG } from 'murow/core/simple-rng';
import { defineProtocol } from 'murow/protocol';
import { VirtualNetwork, VirtualServerTransport } from 'murow/net';
import { networked } from '../components/sync-spec';
import { definePredictions } from '../predictions/define-predictions';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';
import type { Peer } from '../ctx';

const TICK_RATE = 24;
const STEP = 1 / TICK_RATE + 0.001;

const Noise = defineComponent('Noise', {
    schema: { v: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'step' }),
});

interface Call { tick: number; entity: number; n: number; }

describe('prediction RNG rollback', () => {
    test('a replayed prediction consumes the same random sequence', () => {
        const clientCalls: Call[] = [];
        const serverCalls: Call[] = [];

        const protocol = defineProtocol({
            version: 1,
            intents: { roll: { x: f32 } },
            rpcs: {},
        });

        const makePrediction = (record: Call[]) => definePredictions(protocol.intents, {
            roll: (_payload, ctx) => {
                const n = ctx.rng.rand();
                record.push({ tick: ctx.tick, entity: ctx.entity, n });
                if (!ctx.world.has(ctx.entity, Noise)) return;
                const f = ctx.fields(Noise);
                f.v[ctx.entity] += n;
            },
        });

        const clientPreds = makePrediction(clientCalls);
        const serverPreds = makePrediction(serverCalls);

        const vnet = new VirtualNetwork();
        const transport = new VirtualServerTransport({
            vnet,
            rng: new SimpleRNG(123),
            cfg: { baseLatencyMs: 0, jitterMs: 0, lossChance: 0 },
        });

        const serverWorld = new World({ maxEntities: 8, components: [Noise] });
        const serverLoop = new GameLoop({ tickRate: TICK_RATE, type: 'manual-server' });
        const server = new GameServer({
            world: serverWorld,
            loop: serverLoop,
            transport,
            protocol,
            snapshot: { rate: TICK_RATE },
        });
        server.use(serverPreds);

        const { client: clientTransport } = transport.connectClient();
        const clientWorld = new World({ maxEntities: 8, components: [Noise] });
        const clientLoop = new GameLoop({ tickRate: TICK_RATE, type: 'manual-client' });
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol,
            strategy: { kind: 'snapshot-interpolation', delay: 0 },
            now: () => vnet.nowMs(),
        });
        client.use(clientPreds);

        const peerIds = transport.getPeerIds();
        const peer: Peer = { peerId: peerIds[peerIds.length - 1]!, entity: -1 };
        const serverEntity = serverWorld.spawn();
        serverWorld.add(serverEntity, Noise, { v: 0 });
        server.assignEntity(peer, serverEntity);

        let replayed = 0;
        client.on('reconciled', ({ replayed: r }) => { replayed = r; });

        // Bootstrap.
        serverLoop.step(STEP);
        vnet.advance(300);
        clientLoop.step(STEP);
        vnet.advance(300);
        clientLoop.step(STEP);
        expect(client.assignedEntity).not.toBeNull();

        // Delay traffic so the snapshot acking intent A is in flight while B predicts.
        transport.setConfig({ baseLatencyMs: 500, jitterMs: 0, lossChance: 0 });

        expect(client.sendIntent('roll', { x: 0 })).toBe(true);
        vnet.advance(500);
        serverLoop.step(STEP);

        clientLoop.step(STEP);
        expect(client.sendIntent('roll', { x: 0 })).toBe(true);
        const second = clientCalls[clientCalls.length - 1]!;

        vnet.advance(500);
        clientLoop.step(STEP);

        const sameTick = clientCalls.filter(c => c.tick === second.tick);
        expect(replayed).toBeGreaterThan(0);
        expect(sameTick).toHaveLength(2);
        expect(sameTick[0]!.n).toBe(sameTick[1]!.n);

        // The first intent's client prediction and server application also agree.
        expect(serverCalls[0]!.n).toBe(clientCalls[0]!.n);
    });
});

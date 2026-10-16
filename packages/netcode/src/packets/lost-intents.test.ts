import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { definePredictions } from '../predictions/define-predictions';
import { networked } from '../components/sync-spec';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';

const CMSG_INTENT = 0x01;
const STEP = 1 / 60 + 0.001;

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('lost-intent recovery', () => {
    test('retransmits the oldest unacked intent and the server applies it once', async () => {
        const P = defineComponent('P', {
            schema: { x: f32 },
            sync: networked({ rate: 'every-tick', interest: 'global' }),
        });
        const intents = defineIntents({ move: { dx: f32 } });
        const rpcs = defineRpcs({});
        const predictions = definePredictions(intents, {
            move: ({ dx }, ctx) => {
                const f = ctx.fields(P);
                f.x[ctx.entity] += dx;
            },
        });

        const serverWorld = new World({ maxEntities: 8, components: [P] });
        const serverLoop = new GameLoop({ tickRate: 60, type: 'manual-server' });
        const transport = new MemoryServerTransport();
        const server = new GameServer({
            world: serverWorld,
            loop: serverLoop,
            transport,
            protocol: { intents, rpcs },
            snapshot: { rate: 60 },
        });
        server.use(predictions);

        const clientWorld = new World({ maxEntities: 8, components: [P] });
        const clientLoop = new GameLoop({ tickRate: 60, type: 'manual-client' });
        const { client: base } = transport.connectClient();

        let dropped = false;
        let dropCount = 0;
        const wrapped = {
            send: (d: Uint8Array) => {
                if (!dropped && d[0] === CMSG_INTENT) {
                    dropped = true;
                    dropCount++;
                    return;
                }
                base.send(d);
            },
            onMessage: (h: any) => base.onMessage(h),
            onClose: (h: any) => base.onClose(h),
            close: () => base.close(),
        };

        let now = 0;
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: wrapped as any,
            protocol: { intents, rpcs },
            now: () => now,
            retransmitMs: 50,
        });
        client.use(predictions);

        const peerIds = transport.getPeerIds();
        const player = serverWorld.spawn();
        serverWorld.add(player, P, { x: 0 });
        server.assignEntity({ peerId: peerIds[peerIds.length - 1]!, entity: -1 }, player);

        const roundTrip = async () => {
            serverLoop.step(STEP);
            await flush();
            clientLoop.step(STEP);
            await flush();
        };

        for (let i = 0; i < 4; i++) await roundTrip();
        expect(client.assignedEntity).not.toBeNull();

        let retransmits = 0;
        client.on('intent-retransmit', () => retransmits++);

        expect(client.sendIntent('move', { dx: 1 })).toBe(true);
        now += 60; // exceed retransmitMs so the next tick resends

        for (let i = 0; i < 6; i++) await roundTrip();

        expect(dropCount).toBe(1);
        expect(retransmits).toBeGreaterThan(0);
        // Applied exactly once: the retransmit of an already-applied sequence is a no-op.
        expect(serverWorld.get(player, P).x).toBeCloseTo(1, 5);
    });
});

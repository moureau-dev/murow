import { describe, test, expect } from 'bun:test';
import { f32, u32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { defineHandlers } from '../handlers/define-handlers';
import { networked } from '../components/sync-spec';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';
import type { Peer } from '../ctx';

const STEP = 1 / 60 + 0.001;

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('intent outcomes', () => {
    test('a handler rejection reaches the client with its reason', async () => {
        const P = defineComponent('P', { schema: { x: f32 }, sync: networked({ rate: 'every-tick', interest: 'global' }) });
        const intents = defineIntents({ buy: { itemId: u32 } });
        const rpcs = defineRpcs({});
        const handlers = defineHandlers(intents, {
            buy: ({ itemId }) => (itemId === 1 ? { accepted: true } : { accepted: false, reason: 7 }),
        });

        const serverWorld = new World({ maxEntities: 8, components: [P] });
        const serverLoop = new GameLoop({ tickRate: 60, type: 'manual-server' });
        const transport = new MemoryServerTransport();
        const server = new GameServer({
            world: serverWorld,
            loop: serverLoop,
            transport,
            protocol: { intents, rpcs },
        });
        server.use(handlers);

        const clientWorld = new World({ maxEntities: 8, components: [P] });
        const clientLoop = new GameLoop({ tickRate: 60, type: 'manual-client' });
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });
        await flush();

        const peerIds = transport.getPeerIds();
        const peer: Peer = { peerId: peerIds[peerIds.length - 1]!, entity: -1 };
        const serverEntity = serverWorld.spawn();
        serverWorld.add(serverEntity, P, { x: 0 });
        server.assignEntity(peer, serverEntity);

        for (let i = 0; i < 4; i++) {
            serverLoop.step(STEP);
            await flush();
            clientLoop.step(STEP);
            await flush();
        }
        expect(client.assignedEntity).not.toBeNull();

        const outcomes: { sequence: number; accepted: boolean; reason: number }[] = [];
        client.on('outcome', (o: any) => outcomes.push(o));

        expect(client.sendIntent('buy', { itemId: 2 })).toBe(true);
        for (let i = 0; i < 8; i++) {
            serverLoop.step(STEP);
            await flush();
            clientLoop.step(STEP);
            await flush();
        }

        expect(outcomes.length).toBeGreaterThan(0);
        expect(outcomes[0]!.accepted).toBe(false);
        expect(outcomes[0]!.reason).toBe(7);
    });
});

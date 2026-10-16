import { describe, test, expect } from 'bun:test';
import { f32, u16, u32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { networked } from '../components/sync-spec';
import { defineSnapshots, baseline, arrayOf } from '../messages/define-snapshots';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('initial synchronization', () => {
    test('baseline fires on join, client initializes, server gets the ack', async () => {
        const Pos = defineComponent('Pos', { schema: { x: f32 }, sync: networked({ rate: 'every-tick', interest: 'global' }) });
        const intents = defineIntents({ noop: { x: u32 } });
        const rpcs = defineRpcs({});
        const snapshots = defineSnapshots({
            tiles: baseline({ cells: arrayOf({ index: u32, owner: u16 }) }),
        });

        expect(snapshots.baselineKeys).toEqual(['tiles']);

        const transport = new MemoryServerTransport();
        const server = new GameServer({
            world: new World({ maxEntities: 8, components: [Pos] }),
            loop: new GameLoop({ tickRate: 60, type: 'manual-server' }),
            transport,
            protocol: { intents, rpcs, snapshots },
        });

        let baselineResumed: boolean | null = null;
        server.on('baseline', ({ resumed, send }) => {
            baselineResumed = resumed;
            send('tiles', { cells: [{ index: 7, owner: 1 }] });
        });
        let synced: { peerId: string; resumed: boolean } | null = null;
        server.on('synced', ({ peer, resumed }) => { synced = { peerId: peer.peerId, resumed }; });

        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: new World({ maxEntities: 8, components: [Pos] }),
            loop: new GameLoop({ tickRate: 60, type: 'manual-client' }),
            transport: clientTransport,
            protocol: { intents, rpcs, snapshots },
        });

        let initialized = 0;
        client.on('initialized', () => { initialized++; });
        let gotTiles: { index: number; owner: number }[] | null = null;
        client.on('message', (m: any) => { if (m.name === 'tiles') gotTiles = [...m.payload.cells]; });

        const roundTrip = async () => {
            server.loop.step(1 / 60 + 0.001);
            await flush();
            client.loop.step(1 / 60 + 0.001);
            await flush();
        };
        for (let i = 0; i < 4; i++) await roundTrip();

        expect(baselineResumed).toBe(false);
        expect(initialized).toBeGreaterThan(0);
        expect(client.initialized).toBe(true);
        expect(gotTiles).not.toBeNull();
        expect(gotTiles![0]).toEqual({ index: 7, owner: 1 });
        expect(synced).not.toBeNull();
        expect((server as any).peers.get(synced!.peerId).synced).toBe(true);
    });
});

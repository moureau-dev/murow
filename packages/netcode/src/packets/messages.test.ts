import { describe, test, expect } from 'bun:test';
import { u16, u32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { defineSnapshots, arrayOf } from '../messages/define-snapshots';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('custom (non-entity) snapshot types', () => {
    test('round-trips a variable-length message both ways', async () => {
        const Marker = defineComponent('Marker', { _p: u32 });
        const intents = defineIntents({ noop: { x: u32 } });
        const rpcs = defineRpcs({});
        const snapshots = defineSnapshots({
            tiles: { cells: arrayOf({ index: u32, owner: u16 }) },
        });

        const serverWorld = new World({ maxEntities: 8, components: [Marker] });
        const clientWorld = new World({ maxEntities: 8, components: [Marker] });
        const transport = new MemoryServerTransport();
        const server = new GameServer({
            world: serverWorld,
            loop: new GameLoop({ tickRate: 60, type: 'manual-server' }),
            transport,
            protocol: { intents, rpcs, snapshots },
        });
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: new GameLoop({ tickRate: 60, type: 'manual-client' }),
            transport: clientTransport,
            protocol: { intents, rpcs, snapshots },
        });

        await flush();

        // Server -> client.
        let got: { name: string; cells: { index: number; owner: number }[] } | null = null;
        client.on('message', (m: any) => { got = { name: m.name, cells: [...m.payload.cells] }; });
        server.broadcastMessage('tiles', { cells: [{ index: 1, owner: 2 }, { index: 5, owner: 3 }] });
        await flush();
        expect(got).not.toBeNull();
        expect(got!.name).toBe('tiles');
        expect(got!.cells.length).toBe(2);
        expect(got!.cells[0]).toEqual({ index: 1, owner: 2 });
        expect(got!.cells[1]).toEqual({ index: 5, owner: 3 });

        // Client -> server.
        let fromClient: { name: string; peerId: string; cells: unknown[] } | null = null;
        server.on('message', (m: any) => { fromClient = { name: m.name, peerId: m.peer.peerId, cells: [...m.payload.cells] }; });
        client.sendMessage('tiles', { cells: [{ index: 9, owner: 4 }] });
        await flush();
        expect(fromClient).not.toBeNull();
        expect(fromClient!.name).toBe('tiles');
        expect(fromClient!.cells.length).toBe(1);
    });
});

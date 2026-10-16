import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';
import { networked } from '../components/sync-spec';
import type { ServerPlugin } from '../server/plugins/plugin';

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

const Combo = defineComponent('Combo', {
    schema: { v: f32 },
    sync: networked({ rate: 'every-tick', interest: { all: ['a', 'b'] } }),
});
const Either = defineComponent('Either', {
    schema: { v: f32 },
    sync: networked({ rate: 'every-tick', interest: { any: ['a', 'b'] } }),
});
const GlobalEither = defineComponent('GlobalEither', {
    schema: { v: f32 },
    sync: networked({ rate: 'every-tick', interest: { any: ['global', 'a'] } }),
});
const A = defineComponent('A', { _p: f32 });
const B = defineComponent('B', { _p: f32 });

class PluginA implements ServerPlugin {
    readonly name = 'a';
    filterSnapshot(_peer: any, world: World, dirty: ReadonlyArray<number>, out: number[]): void {
        for (let i = 0; i < dirty.length; i++) if (world.has(dirty[i]!, A)) out.push(dirty[i]!);
    }
}
class PluginB implements ServerPlugin {
    readonly name = 'b';
    filterSnapshot(_peer: any, world: World, dirty: ReadonlyArray<number>, out: number[]): void {
        for (let i = 0; i < dirty.length; i++) if (world.has(dirty[i]!, B)) out.push(dirty[i]!);
    }
}

describe('composable interest', () => {
    test('{ all } is intersection, { any } is union, and global inside a list always admits', async () => {
        const intents = defineIntents({ noop: { x: f32 } });
        const rpcs = defineRpcs({});
        const components = [Combo, Either, GlobalEither, A, B];
        const serverWorld = new World({ maxEntities: 32, components });
        const clientWorld = new World({ maxEntities: 32, components });
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
        server.use(new PluginA());
        server.use(new PluginB());
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });

        const spawn = (markerA: boolean, markerB: boolean): number => {
            const e = serverWorld.spawn();
            serverWorld.add(e, Combo, { v: 1 });
            serverWorld.add(e, Either, { v: 2 });
            if (markerA) serverWorld.add(e, A, { _p: 0 });
            if (markerB) serverWorld.add(e, B, { _p: 0 });
            return e;
        };

        const both = spawn(true, true);
        const onlyA = spawn(true, false);
        const onlyB = spawn(false, true);
        const neither = spawn(false, false);
        serverWorld.add(neither, GlobalEither, { v: 9 });

        server.assignEntity({ peerId: transport.getPeerIds()[0]!, entity: -1 }, both);

        serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);
        await flush();

        const local = (serverEid: number): number | undefined =>
            (client as any).serverToLocal.get(serverEid);

        const bothLocal = local(both)!;
        expect(clientWorld.has(bothLocal, Combo)).toBe(true);   // a and b both admit
        expect(clientWorld.has(bothLocal, Either)).toBe(true);

        const onlyALocal = local(onlyA)!;
        expect(clientWorld.has(onlyALocal, Combo)).toBe(false); // a admits, b does not → all fails
        expect(clientWorld.has(onlyALocal, Either)).toBe(true);  // any holds

        const onlyBLocal = local(onlyB)!;
        expect(clientWorld.has(onlyBLocal, Combo)).toBe(false);
        expect(clientWorld.has(onlyBLocal, Either)).toBe(true);

        const neitherLocal = local(neither);
        if (neitherLocal !== undefined) {
            // Only GlobalEither could ship the entity; global in a list always admits.
            expect(clientWorld.has(neitherLocal, GlobalEither)).toBe(true);
            expect(clientWorld.has(neitherLocal, Combo)).toBe(false);
        }
        expect(neitherLocal).toBeDefined();
    });
});

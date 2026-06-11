import { describe, test, expect } from 'bun:test';
import { f32, u8, u16, string } from 'murow/core/binary-codec';
import { World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { defineIntents } from './intents/define-intents';
import { defineRpcs } from './rpcs/define-rpcs';
import { GameServer } from './server/game-server';
import { GameClient } from './client/game-client';
import { MemoryServerTransport } from 'murow/net';

/**
 * Compile-time tests for the typed `sendIntent` / `sendRpc` / `broadcastRpc`
 * surface. The runtime assertions are minimal — the value of this file is
 * that it must *compile*. Every `@ts-expect-error` line below documents a
 * specific call that must remain rejected; if the typing regresses to
 * `any`, those lines would silently compile, the `@ts-expect-error` itself
 * would become unused, and `tsc` would fail the build.
 */

const intents = defineIntents({
    move: { dx: f32, dy: f32 },
    attack: { targetId: u16 },
});

const rpcs = defineRpcs({
    matchCountdown: { secondsRemaining: u8 },
    buyItem: { itemId: string(16) },
});

describe('typed call sites', () => {
    test('client.sendIntent and sendRpc enforce the schema at compile time', () => {
        const world = new World({ maxEntities: 8, components: [] });
        const loop = new GameLoop({ tickRate: 60, type: 'manual-client' });
        const transport = new MemoryServerTransport();
        const { client: clientTransport } = transport.connectClient();

        const client = new GameClient({
            world,
            loop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });

        // Compiles: correct shapes.
        client.sendIntent('move', { dx: 1, dy: 0 });
        client.sendIntent('attack', { targetId: 42 });
        client.sendRpc('matchCountdown', { secondsRemaining: 5 });
        client.sendRpc('buyItem', { itemId: 'sword' });

        // @ts-expect-error — missing field
        client.sendIntent('move', { dx: 1 });

        // @ts-expect-error — wrong field name
        client.sendIntent('move', { x: 1, y: 0 });

        // @ts-expect-error — unknown intent name
        client.sendIntent('teleport', { x: 0, y: 0 });

        // @ts-expect-error — wrong field type (string where number expected)
        client.sendIntent('attack', { targetId: 'bad' });

        // @ts-expect-error — missing field on RPC
        client.sendRpc('matchCountdown', {});

        // @ts-expect-error — unknown RPC method
        client.sendRpc('unknownMethod', {});

        expect(client).toBeDefined();
    });

    test('server.sendRpc and broadcastRpc enforce the schema at compile time', () => {
        const world = new World({ maxEntities: 8, components: [] });
        const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
        const transport = new MemoryServerTransport();

        const server = new GameServer({
            world,
            loop,
            transport,
            protocol: { intents, rpcs },
        });

        // Compiles: correct shapes.
        server.broadcastRpc('matchCountdown', { secondsRemaining: 3 });
        server.broadcastRpc('buyItem', { itemId: 'sword' });

        // @ts-expect-error — wrong field type
        server.broadcastRpc('matchCountdown', { secondsRemaining: 'three' });

        // @ts-expect-error — missing field
        server.broadcastRpc('matchCountdown', {});

        // @ts-expect-error — unknown RPC method
        server.broadcastRpc('teleport', {});

        // sendRpc takes the same shape.
        const peer = { peerId: 'peer_x', entity: -1 as const };
        server.sendRpc(peer, 'matchCountdown', { secondsRemaining: 1 });

        // @ts-expect-error — wrong shape
        server.sendRpc(peer, 'matchCountdown', { wrong: true });

        expect(server).toBeDefined();
    });
});

import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { defineIntents } from './intents/define-intents';
import { defineRpcs } from './rpcs/define-rpcs';
import { GameServer } from './server/game-server';
import { GameClient } from './client/game-client';
import { MemoryServerTransport } from 'murow/net';
import type { ServerEventPayloads, ClientEventPayloads } from './network/base';
import { networked } from './components/sync-spec';

async function flush(): Promise<void> {
    for (let i = 0; i < 2; i++) await Promise.resolve();
}

const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global' }),
});

function setup(opts?: { graceMs?: number }) {
    const intents = defineIntents({ noop: { x: f32 } });
    const rpcs = defineRpcs({});
    const serverWorld = new World({ maxEntities: 16, components: [Position] });
    const serverLoop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    const transport = new MemoryServerTransport();
    const server = new GameServer({
        world: serverWorld,
        loop: serverLoop,
        transport,
        protocol: { intents, rpcs },
        snapshot: { rate: 60 },
        reconnection: { graceMs: opts?.graceMs ?? 1000 },
    });
    return { intents, rpcs, serverWorld, serverLoop, transport, server };
}

function connect(ctx: ReturnType<typeof setup>, reconnection: boolean | { token?: string }) {
    const clientWorld = new World({ maxEntities: 16, components: [Position] });
    const clientLoop = new GameLoop({ tickRate: 60, type: 'manual-client' });
    const { client: clientTransport, peerId } = ctx.transport.connectClient();
    const client = new GameClient({
        world: clientWorld,
        loop: clientLoop,
        transport: clientTransport,
        protocol: { intents: ctx.intents, rpcs: ctx.rpcs },
        strategy: { kind: 'snapshot-interpolation', delay: 0 },
        reconnection,
    });
    return { client, clientWorld, clientLoop, peerId };
}

describe('reconnection', () => {
    test('a reconnecting client resumes its entity instead of being treated as new', async () => {
        const ctx = setup();
        const conn: ServerEventPayloads['connection'][] = [];
        ctx.server.on('connection', (e) => conn.push(e));

        const a = connect(ctx, true);
        await flush();
        expect(conn.length).toBe(1);

        const entity = ctx.serverWorld.spawn();
        ctx.serverWorld.add(entity, Position, { x: 1, y: 2 });
        ctx.server.assignEntity(conn[0]!.peer, entity);

        const suspended: ServerEventPayloads['suspended'][] = [];
        const disconn: ServerEventPayloads['disconnection'][] = [];
        ctx.server.on('suspended', (e) => suspended.push(e));
        ctx.server.on('disconnection', (e) => disconn.push(e));

        const token = a.client.sessionToken;
        expect(token).not.toBe('');

        // Drop client A's transport. The session is held, not finalized.
        ctx.transport.getPeer(a.peerId)!.close();
        await flush();
        expect(suspended.length).toBe(1);
        expect(disconn.length).toBe(0);

        const rec: ServerEventPayloads['reconnection'][] = [];
        ctx.server.on('reconnection', (e) => rec.push(e));
        const reconnected: ClientEventPayloads['reconnected'][] = [];

        // Reconnect with the token: a fresh client instance resuming.
        const b = connect(ctx, { token });
        b.client.on('reconnected', (e) => reconnected.push(e));
        await flush();

        expect(rec.length).toBe(1);
        expect(rec[0]!.peer.entity).toBe(entity);
        expect(conn.length).toBe(1);            // no fresh `connection`
        expect(disconn.length).toBe(0);         // session never finalized
        expect(reconnected.length).toBe(1);     // client learned it resumed
        expect(b.client.sessionToken).toBe(token);

        // Re-baseline: the entity spawns and the assignment is replayed.
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        b.clientLoop.step(1 / 60 + 0.001);
        expect(b.client.assignedEntity).not.toBeNull();
    });

    test('a held session times out and then disconnects', async () => {
        const ctx = setup({ graceMs: 20 });
        const conn: ServerEventPayloads['connection'][] = [];
        ctx.server.on('connection', (e) => conn.push(e));

        const a = connect(ctx, true);
        await flush();

        const entity = ctx.serverWorld.spawn();
        ctx.serverWorld.add(entity, Position, { x: 0, y: 0 });
        ctx.server.assignEntity(conn[0]!.peer, entity);

        const disconn: ServerEventPayloads['disconnection'][] = [];
        ctx.server.on('disconnection', (e) => disconn.push(e));

        ctx.transport.getPeer(a.peerId)!.close();
        await new Promise((r) => setTimeout(r, 60));

        expect(disconn.length).toBe(1);
        expect(disconn[0]!.reason).toBe('reconnect-timeout');
    });

    test('an unmatched token is treated as a new peer', async () => {
        const ctx = setup();
        const conn: ServerEventPayloads['connection'][] = [];
        const rec: ServerEventPayloads['reconnection'][] = [];
        ctx.server.on('connection', (e) => conn.push(e));
        ctx.server.on('reconnection', (e) => rec.push(e));

        connect(ctx, { token: 'not-a-real-session' });
        await flush();

        expect(conn.length).toBe(1);
        expect(rec.length).toBe(0);
    });
});

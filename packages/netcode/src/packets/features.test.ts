import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { defineIntents } from '../intents/define-intents';
import { defineRpcs } from '../rpcs/define-rpcs';
import { definePredictions } from '../predictions/define-predictions';
import { GameServer } from '../server/game-server';
import { GameClient } from '../client/game-client';
import { SnapshotInterpolation, type BufferedSnapshot } from '../client/strategies/snapshot-interpolation';
import { networked } from '../components/sync-spec';
import type { ServerPlugin } from '../server/plugins/plugin';
import { AoiGrid } from '../server/plugins/aoi-grid';

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('slerp interpolation', () => {
    const Rotation = defineComponent('Rotation', {
        schema: { x: f32, y: f32, z: f32, w: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global', interp: 'slerp' }),
    });
    const Scale = defineComponent('Scale', {
        schema: { s: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global', interp: 'slerp' }), // not a quat → lerp fallback
    });

    function snap(tick: number, receivedAt: number, values: Record<string, number>, c: any): BufferedSnapshot {
        return {
            receivedAt,
            serverTick: tick,
            entityIds: [1],
            componentValuesByEntity: new Map([[1, new Map([[c, values]])]]),
        };
    }

    test('interpolates along the shortest arc (unit quaternion, not a lerp)', () => {
        const world = new World({ maxEntities: 4, components: [Rotation] });
        const e = world.spawn();
        world.add(e, Rotation, { x: 0, y: 0, z: 0, w: 1 });

        const map = new Map<number, number>([[1, e]]);
        const buf = new SnapshotInterpolation(map, 8, 0, 300);
        buf.record(snap(0, 0, { x: 0, y: 0, z: 0, w: 1 }, Rotation));
        buf.record(snap(1, 100, { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, Rotation));

        // now = 75 → render tick 0.75 between the two snapshots.
        buf.apply(world, 75, [Rotation], () => false);

        const q = world.get(e, Rotation);
        const norm = Math.hypot(q.x, q.y, q.z, q.w);
        expect(norm).toBeCloseTo(1, 3);                       // slerp stays on the unit sphere
        // 0.75 of 90° about Z = 67.5° → (0,0,sin33.75,cos33.75)
        expect(q.z).toBeCloseTo(Math.sin((Math.PI / 2) * 0.75 / 2), 3);
        expect(q.w).toBeCloseTo(Math.cos((Math.PI / 2) * 0.75 / 2), 3);
    });

    test('falls back to lerp for a non-quaternion component', () => {
        const world = new World({ maxEntities: 4, components: [Scale] });
        const e = world.spawn();
        world.add(e, Scale, { s: 0 });
        const map = new Map<number, number>([[1, e]]);
        const buf = new SnapshotInterpolation(map, 8, 0, 300);
        buf.record(snap(0, 0, { s: 0 }, Scale));
        buf.record(snap(1, 100, { s: 4 }, Scale));
        buf.apply(world, 75, [Scale], () => false);
        expect(world.get(e, Scale).s).toBeGreaterThan(0);
        expect(world.get(e, Scale).s).toBeLessThan(4);
    });
});

describe('per-component interest', () => {
    const Public = defineComponent('Public', {
        schema: { v: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global' }),
    });
    const Secret = defineComponent('Secret', {
        schema: { v: f32 },
        sync: networked({ rate: 'every-tick', interest: 'aoi' }),
    });
    const Marker = defineComponent('Marker', { _p: f32 });

    /** Includes only entities carrying Marker. */
    class MarkerOnly implements ServerPlugin {
        readonly name = 'aoi';
        filterSnapshot(_peer: any, world: World, dirty: ReadonlyArray<number>, out: number[]): void {
            for (let i = 0; i < dirty.length; i++) if (world.has(dirty[i]!, Marker)) out.push(dirty[i]!);
        }
    }

    function setup() {
        const intents = defineIntents({ noop: { x: f32 } });
        const rpcs = defineRpcs({});
        const serverWorld = new World({ maxEntities: 32, components: [Public, Secret, Marker] });
        const clientWorld = new World({ maxEntities: 32, components: [Public, Secret, Marker] });
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
        server.use(new MarkerOnly());
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });
        return { server, serverWorld, serverLoop, client, clientWorld, clientLoop, transport };
    }

    test('interest gates a component by its plugin, while global forces inclusion', async () => {
        const { serverWorld, serverLoop, clientWorld, clientLoop, transport, server, client } = setup();

        const a = serverWorld.spawn(); // marker → aoi plugin keeps it
        serverWorld.add(a, Public, { v: 1 });
        serverWorld.add(a, Secret, { v: 11 });
        serverWorld.add(a, Marker, { _p: 0 });

        const b = serverWorld.spawn(); // no marker → aoi drops Secret, but Public is global
        serverWorld.add(b, Public, { v: 2 });
        serverWorld.add(b, Secret, { v: 22 });

        const x = serverWorld.spawn(); // only Secret, no marker → excluded entirely
        serverWorld.add(x, Secret, { v: 33 });

        server.assignEntity({ peerId: transport.getPeerIds()[0]!, entity: -1 }, a);

        serverLoop.step(1 / 60 + 0.001);
        await flush();
        clientLoop.step(1 / 60 + 0.001);
        await flush();

        const localOf = (serverEid: number): number | undefined =>
            (client as any).serverToLocal.get(serverEid);

        const ca = localOf(a as number)!;
        expect(clientWorld.has(ca, Public)).toBe(true);
        expect(clientWorld.has(ca, Secret)).toBe(true); // in AOI

        const cb = localOf(b as number);
        if (cb !== undefined) {
            expect(clientWorld.has(cb, Public)).toBe(true);      // global forces inclusion
            expect(clientWorld.has(cb, Secret)).toBe(false);     // aoi dropped it
        }

        expect(localOf(x as number)).toBeUndefined();             // no shipping component → not sent

        void server;
    });
});

describe('per-component snapThreshold', () => {
    const Pos = defineComponent('Pos', {
        schema: { x: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global' }),
    });
    const Ammo = defineComponent('Ammo', {
        schema: { n: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global', snapThreshold: 1 }),
    });

    function setup() {
        const intents = defineIntents({ noop: { x: f32 } });
        const rpcs = defineRpcs({});
        const serverWorld = new World({ maxEntities: 32, components: [Pos, Ammo] });
        const clientWorld = new World({ maxEntities: 32, components: [Pos, Ammo] });
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
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });
        return { server, serverWorld, serverLoop, client, clientWorld, clientLoop, transport };
    }

    async function roundTrip(ctx: ReturnType<typeof setup>): Promise<void> {
        ctx.serverLoop.step(1 / 60 + 0.001);
        await flush();
        ctx.clientLoop.step(1 / 60 + 0.001);
        await flush();
    }

    test('sub-threshold correction keeps the client value; large snap applies', async () => {
        const ctx = setup();
        const { serverWorld, clientWorld, transport, server } = ctx;

        const e = serverWorld.spawn();
        serverWorld.add(e, Pos, { x: 0 });
        serverWorld.add(e, Ammo, { n: 10 });
        server.assignEntity({ peerId: transport.getPeerIds()[0]!, entity: -1 }, e);

        await roundTrip(ctx);
        const ce = (ctx.client as any).serverToLocal.get(e as number) as number;
        expect(clientWorld.get(ce, Ammo).n).toBeCloseTo(10, 5);

        // Server nudges Ammo by 0.5 — within the component's snapThreshold of 1.
        serverWorld.update(e, Ammo, { n: 10.5 });
        await roundTrip(ctx);
        expect(clientWorld.get(ce, Ammo).n).toBeCloseTo(10, 5); // kept (dead-zone)

        // Server corrects by 10 — above the threshold → snaps.
        serverWorld.update(e, Ammo, { n: 20 });
        await roundTrip(ctx);
        expect(clientWorld.get(ce, Ammo).n).toBeCloseTo(20, 5);

        void server;
    });
});

describe('AOI enter/leave', () => {
    const Pos = defineComponent('Pos', {
        schema: { x: f32, y: f32 },
        sync: networked({ rate: 'every-tick', interest: 'aoi' }),
    });

    test('an entity leaving the radius is despawned on the client', async () => {
        const intents = defineIntents({ noop: { x: f32 } });
        const rpcs = defineRpcs({});
        const serverWorld = new World({ maxEntities: 32, components: [Pos] });
        const clientWorld = new World({ maxEntities: 32, components: [Pos] });
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
        server.use(new AoiGrid({ cellSize: 8, radius: 10, positionComponent: Pos }));
        const { client: clientTransport } = transport.connectClient();
        const client = new GameClient({
            world: clientWorld,
            loop: clientLoop,
            transport: clientTransport,
            protocol: { intents, rpcs },
        });

        const player = serverWorld.spawn();
        serverWorld.add(player, Pos, { x: 0, y: 0 });
        const enemy = serverWorld.spawn();
        serverWorld.add(enemy, Pos, { x: 5, y: 0 }); // inside radius 10
        server.assignEntity({ peerId: transport.getPeerIds()[0]!, entity: -1 }, player);

        const roundTrip = async () => {
            serverLoop.step(1 / 60 + 0.001);
            await flush();
            clientLoop.step(1 / 60 + 0.001);
            await flush();
        };

        await roundTrip();
        const ce = (client as any).serverToLocal.get(enemy as number) as number;
        expect(ce).toBeDefined();
        expect(clientWorld.has(ce, Pos)).toBe(true);

        // Move the enemy well outside the AOI radius.
        serverWorld.update(enemy, Pos, { x: 100, y: 0 });
        await roundTrip();

        const after = (client as any).serverToLocal.get(enemy as number);
        expect(after === undefined || !clientWorld.has(after, Pos)).toBe(true);
    });
});

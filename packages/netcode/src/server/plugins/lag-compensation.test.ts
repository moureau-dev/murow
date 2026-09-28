import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World, type Entity } from 'murow/ecs';
import { networked } from '../../components/sync-spec';
import { LagCompensation } from './lag-compensation';

const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

const Velocity = defineComponent('Velocity', {
    schema: { vx: f32, vy: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

function makeWorld(maxEntities = 64): World {
    return new World({ maxEntities, components: [Position, Velocity] });
}

/** Write a component field directly and mark it dirty, like a real system would. */
function setPos(world: World, e: Entity, x: number, y: number): void {
    const p = world.fields(Position);
    p.x[e] = x;
    p.y[e] = y;
    world.markDirty(e, Position.__worldIndex!);
}

describe('LagCompensation', () => {
    test('rewinds to the requested tick and restores afterwards', () => {
        const world = makeWorld();
        const e = world.spawn();
        world.add(e, Position, { x: 0, y: 0 });

        const plugin = new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] });
        plugin.onMount({ world } as any);

        const T = 8;
        for (let t = 1; t <= T; t++) {
            setPos(world, e, t, t * 10);
            plugin.onTick(world, 1 / 20);
            world.clearAllDirty();
        }

        // Inside the rewind, the entity reads the historical state...
        const seen = plugin.rewind(3, () => ({ ...world.get(e, Position) }));
        expect(seen.x).toBe(3);
        expect(seen.y).toBe(30);

        // ...and the live state is restored once the callback returns.
        const live = world.get(e, Position);
        expect(live.x).toBe(T);
        expect(live.y).toBe(T * 10);
    });

    test('restores every tweaked component', () => {
        const world = makeWorld();
        const e = world.spawn();
        world.add(e, Position, { x: 0, y: 0 });
        world.add(e, Velocity, { vx: 1, vy: 1 });

        const plugin = new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position, Velocity] });
        plugin.onMount({ world } as any);

        for (let t = 1; t <= 6; t++) {
            setPos(world, e, t, t);
            const v = world.fields(Velocity);
            v.vx[e] = t * 2;
            v.vy[e] = t * 3;
            world.markDirty(e, Velocity.__worldIndex!);
            plugin.onTick(world, 1 / 20);
            world.clearAllDirty();
        }

        const inside = plugin.rewind(4, () => ({
            p: { ...world.get(e, Position) },
            v: { ...world.get(e, Velocity) },
        }));
        expect(inside.p.x).toBe(4);
        expect(inside.v.vx).toBe(8);
        expect(inside.v.vy).toBe(12);

        const p = world.get(e, Position);
        const v = world.get(e, Velocity);
        expect(p.x).toBe(6);
        expect(v.vx).toBe(12);
    });

    test('picks the nearest frame when the exact tick is unavailable', () => {
        const world = makeWorld();
        const e = world.spawn();
        world.add(e, Position, { x: 0, y: 0 });

        const plugin = new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] });
        plugin.onMount({ world } as any);

        for (let t = 1; t <= 5; t++) {
            setPos(world, e, t * 100, 0);
            plugin.onTick(world, 1 / 20);
            world.clearAllDirty();
        }

        // Tick 2 is behind the history window only if it was pruned; with a
        // 500ms window nothing is pruned here, so query a tick that exists.
        const exact = plugin.rewind(2, () => world.get(e, Position).x);
        expect(exact).toBe(200);

        // Out-of-range tick clamps to the nearest retained frame rather than
        // throwing, and still restores afterwards.
        const nearest = plugin.rewind(999, () => world.get(e, Position).x);
        expect(nearest).toBe(500);
        expect(world.get(e, Position).x).toBe(500);
    });

    test('falls back to recording all entities when nothing is dirty', () => {
        const world = makeWorld();
        const e = world.spawn();
        world.add(e, Position, { x: 0, y: 0 });
        world.clearAllDirty();

        const plugin = new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] });
        plugin.onMount({ world } as any);

        for (let t = 1; t <= 4; t++) {
            const p = world.fields(Position);
            p.x[e] = t * 7; // direct write, deliberately no markDirty
            p.y[e] = 0;
            plugin.onTick(world, 1 / 20);
            world.clearAllDirty();
        }

        const v = plugin.rewind(2, () => world.get(e, Position).x);
        expect(v).toBe(14);
        expect(world.get(e, Position).x).toBe(28);
    });

    test('is a pass-through when nothing has been recorded', () => {
        const world = makeWorld();
        const plugin = new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] });
        plugin.onMount({ world } as any);

        let ran = false;
        const out = plugin.rewind(3, () => {
            ran = true;
            return 42;
        });
        expect(ran).toBe(true);
        expect(out).toBe(42);
    });
});

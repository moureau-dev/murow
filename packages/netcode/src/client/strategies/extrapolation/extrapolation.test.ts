import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { ExtrapolationStrategy } from './extrapolation';
import { PeerRenderStrategy } from '../strategy';
import type { BufferedSnapshot } from '../interpolation';

describe('ExtrapolationStrategy', () => {
    const P = defineComponent('P', { x: f32 });

    function snap(tick: number, receivedAt: number, x: number): BufferedSnapshot {
        return {
            receivedAt,
            serverTick: tick,
            entityIds: [1],
            componentValuesByEntity: new Map([[1, [{ x }]]]),
        };
    }

    function setup(nowVal: number) {
        const world = new World({ maxEntities: 4, components: [P] });
        const e = world.spawn();
        world.add(e, P, { x: 0 });
        const s = new ExtrapolationStrategy({ maxExtrapolationMs: 200 });
        s.bind({ serverToLocal: new Map([[1, e]]), now: () => nowVal, tickIntervalMs: 16, capacity: 8 });
        return { world, e, s };
    }

    test('projects forward from the last velocity', () => {
        const { world, e, s } = setup(40);
        expect(s).toBeInstanceOf(PeerRenderStrategy);
        s.record(snap(0, 0, 0));
        s.record(snap(1, 16, 1.6)); // 0.1 per ms
        s.apply(world, 40, [P], () => false); // 24 ms past newest → 1.6 + 2.4
        expect(world.get(e, P).x).toBeCloseTo(4, 3);
    });

    test('caps projection at maxExtrapolationMs', () => {
        const { world, e, s } = setup(1000);
        s.record(snap(0, 0, 0));
        s.record(snap(1, 16, 1.6));
        s.apply(world, 1000, [P], () => false); // capped at 200 ms → 1.6 + 20
        expect(world.get(e, P).x).toBeCloseTo(21.6, 3);
    });

    test('holds the newest value with a single snapshot', () => {
        const { world, e, s } = setup(500);
        s.record(snap(0, 0, 7));
        s.apply(world, 500, [P], () => false);
        expect(world.get(e, P).x).toBeCloseTo(7, 5);
    });
});

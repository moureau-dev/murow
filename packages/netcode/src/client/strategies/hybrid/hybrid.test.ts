import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { HybridStrategy } from './hybrid';
import { PeerRenderStrategy } from '../strategy';
import type { BufferedSnapshot } from '../interpolation';

describe('HybridStrategy', () => {
    const P = defineComponent('P', { x: f32 });

    function snap(tick: number, receivedAt: number, x: number): BufferedSnapshot {
        return {
            receivedAt,
            serverTick: tick,
            entityIds: [1],
            componentValuesByEntity: new Map([[1, [{ x }]]]),
        };
    }

    function setup() {
        const world = new World({ maxEntities: 4, components: [P] });
        const e = world.spawn();
        world.add(e, P, { x: 0 });
        const s = new HybridStrategy({ delay: 0, maxExtrapolationMs: 200 });
        s.bind({ serverToLocal: new Map([[1, e]]), now: () => 0, tickIntervalMs: 100, capacity: 8 });
        s.record(snap(0, 0, 0));
        s.record(snap(1, 100, 10)); // 0.1 per ms
        return { world, e, s };
    }

    test('interpolates while a snapshot lies ahead', () => {
        const { world, e, s } = setup();
        expect(s).toBeInstanceOf(PeerRenderStrategy);
        s.apply(world, 75, [P], () => false); // starveAge = -25 → interpolate
        const x = world.get(e, P).x;
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(10);
    });

    test('extrapolates (capped) once starved', () => {
        const { world, e, s } = setup();
        s.apply(world, 1000, [P], () => false); // starveAge 900 → capped 200 ms
        expect(world.get(e, P).x).toBeCloseTo(30, 3); // 10 + 0.1 * 200
    });
});

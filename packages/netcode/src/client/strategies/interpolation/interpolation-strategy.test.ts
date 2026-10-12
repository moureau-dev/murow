import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { SnapshotInterpolationStrategy } from './interpolation';
import { PeerRenderStrategy } from '../strategy';
import type { BufferedSnapshot } from './interpolation';

describe('SnapshotInterpolationStrategy', () => {
    const P = defineComponent('P', { x: f32 });

    function snap(tick: number, receivedAt: number, x: number): BufferedSnapshot {
        return {
            receivedAt,
            serverTick: tick,
            entityIds: [1],
            componentValuesByEntity: new Map([[1, new Map([[P, { x }]])]]),
        };
    }

    test('is a PeerRenderStrategy: binds, records, and applies', () => {
        const world = new World({ maxEntities: 4, components: [P] });
        const e = world.spawn();
        world.add(e, P, { x: 0 });

        const strategy = new SnapshotInterpolationStrategy({ delay: 0, staleWindow: 300 });
        expect(strategy).toBeInstanceOf(PeerRenderStrategy);
        expect(strategy.delay).toBe(0);

        strategy.bind({
            serverToLocal: new Map([[1, e]]),
            now: () => 0,
            tickIntervalMs: 100,
            capacity: 8,
        });

        strategy.record(snap(0, 0, 0));
        strategy.record(snap(1, 100, 10));
        strategy.apply(world, 75, [P], () => false);

        const x = world.get(e, P).x;
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(10);

        strategy.clear();
    });

    test('setDelay updates both the strategy and its renderer', () => {
        const strategy = new SnapshotInterpolationStrategy({ delay: 100 });
        strategy.bind({ serverToLocal: new Map(), now: () => 0, tickIntervalMs: 16, capacity: 8 });
        strategy.setDelay(250);
        expect(strategy.delay).toBe(250);
    });

    test('base tuners are safe no-ops before bind', () => {
        const strategy = new SnapshotInterpolationStrategy();
        strategy.setDelay(1);
        strategy.setMaxDesync(1);
        strategy.setMaxBridgeGap(1);
        strategy.setStaleWindow(1);
        expect(strategy.delay).toBe(1);
    });
});

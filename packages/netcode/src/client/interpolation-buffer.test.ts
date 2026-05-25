import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World, type Component } from 'murow/ecs';
import { networked } from '../components/sync-spec';
import { InterpolationBuffer, type BufferedSnapshot } from './interpolation-buffer';

describe('InterpolationBuffer', () => {
    const Position = defineComponent('Position', {
        schema: { x: f32, y: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
    });

    function setup() {
        const world = new World({ maxEntities: 16, components: [Position] });
        const serverToLocal = new Map<number, number>();
        const localEid = world.spawn();
        world.add(localEid, Position, { x: 0, y: 0 });
        serverToLocal.set(100, localEid);
        return { world, serverToLocal, localEid };
    }

    function snap(
        receivedAt: number,
        tick: number,
        values: { serverEid: number; comp: Component<any>; value: Record<string, number> }[],
    ): BufferedSnapshot {
        const m = new Map<number, Map<Component<any>, Record<string, number>>>();
        const ids: number[] = [];
        for (const v of values) {
            if (!ids.includes(v.serverEid)) ids.push(v.serverEid);
            let inner = m.get(v.serverEid);
            if (inner === undefined) {
                inner = new Map();
                m.set(v.serverEid, inner);
            }
            inner.set(v.comp, v.value);
        }
        return { receivedAt, serverTick: tick, entityIds: ids, componentValuesByEntity: m };
    }

    test('interpolates linearly between two straddling snapshots', () => {
        const { world, serverToLocal, localEid } = setup();
        const buf = new InterpolationBuffer(serverToLocal, 8, 100, 300);

        // A at t=1000 with position (0, 0).
        buf.record(snap(1000, 1, [{ serverEid: 100, comp: Position, value: { x: 0, y: 0 } }]));
        // B at t=1100 with position (100, 0).
        buf.record(snap(1100, 2, [{ serverEid: 100, comp: Position, value: { x: 100, y: 0 } }]));

        // renderTime = 1200 - 100 = 1100 → equals B → pick B.
        buf.apply(world, 1200, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(100);

        // renderTime = 1150 - 100 = 1050 → halfway → 50.
        buf.apply(world, 1150, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(50);

        // renderTime = 1110 - 100 = 1010 → 10% → 10.
        buf.apply(world, 1110, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(10);
    });

    test('underrun (renderTime before oldest) holds the previous World value', () => {
        const { world, serverToLocal, localEid } = setup();
        const buf = new InterpolationBuffer(serverToLocal, 8, 100, 300);
        buf.record(snap(2000, 1, [{ serverEid: 100, comp: Position, value: { x: 50, y: 50 } }]));
        buf.record(snap(2100, 2, [{ serverEid: 100, comp: Position, value: { x: 100, y: 100 } }]));

        // renderTime = 1000 - 100 = 900, way before 2000 → underrun.
        // Buffer leaves World alone (the entity stays at its previous
        // (0, 0) position from the test setup) instead of jumping to
        // the future snapshot.
        buf.apply(world, 1000, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(0);
        expect(world.get(localEid, Position).y).toBeCloseTo(0);
    });

    test('overrun (renderTime past newest) clamps to newest', () => {
        const { world, serverToLocal, localEid } = setup();
        const buf = new InterpolationBuffer(serverToLocal, 8, 100, 300);
        buf.record(snap(1000, 1, [{ serverEid: 100, comp: Position, value: { x: 0, y: 0 } }]));
        buf.record(snap(1100, 2, [{ serverEid: 100, comp: Position, value: { x: 100, y: 0 } }]));

        // renderTime = 5000 - 100 = 4900, way past 1100 → use newest.
        buf.apply(world, 5000, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(100);
    });

    test('skipped (predicted) entities are not overwritten', () => {
        const { world, serverToLocal, localEid } = setup();
        const buf = new InterpolationBuffer(serverToLocal, 8, 100, 300);

        world.update(localEid, Position, { x: 999, y: 999 });
        buf.record(snap(1000, 1, [{ serverEid: 100, comp: Position, value: { x: 0, y: 0 } }]));
        buf.record(snap(1100, 2, [{ serverEid: 100, comp: Position, value: { x: 100, y: 0 } }]));

        buf.apply(world, 1150, [Position], (e) => e === localEid);
        expect(world.get(localEid, Position).x).toBe(999);
    });

    test('"step" interp mode picks A while t < 0.5, B otherwise', () => {
        const StepComp = defineComponent('StepComp', {
            schema: { v: f32 },
            sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
        });
        const world = new World({ maxEntities: 16, components: [StepComp] });
        const serverToLocal = new Map<number, number>();
        const localEid = world.spawn();
        world.add(localEid, StepComp, { v: 0 });
        serverToLocal.set(100, localEid);

        const buf = new InterpolationBuffer(serverToLocal, 8, 100, 300);
        buf.record(snap(1000, 1, [{ serverEid: 100, comp: StepComp, value: { v: 0 } }]));
        buf.record(snap(1100, 2, [{ serverEid: 100, comp: StepComp, value: { v: 1 } }]));

        // renderTime = 1130 - 100 = 1030 → t=0.3 → A (v=0).
        buf.apply(world, 1130, [StepComp], () => false);
        expect(world.get(localEid, StepComp).v).toBe(0);

        // renderTime = 1180 - 100 = 1080 → t=0.8 → B (v=1).
        buf.apply(world, 1180, [StepComp], () => false);
        expect(world.get(localEid, StepComp).v).toBe(1);
    });

    test('capacity prunes oldest snapshots', () => {
        const { world, serverToLocal, localEid } = setup();
        const buf = new InterpolationBuffer(serverToLocal, 2, 100, 300);
        buf.record(snap(1000, 1, [{ serverEid: 100, comp: Position, value: { x: 0, y: 0 } }]));
        buf.record(snap(1100, 2, [{ serverEid: 100, comp: Position, value: { x: 50, y: 0 } }]));
        buf.record(snap(1200, 3, [{ serverEid: 100, comp: Position, value: { x: 100, y: 0 } }]));

        // t=1000 evicted. renderTime = 1200 - 100 = 1100 → straddles
        // the remaining pair (1100, 1200) at t=0 → ~50.
        buf.apply(world, 1200, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(50);
    });

    test('a long idle gap prunes the stale tail; new snapshot waits out the delay', () => {
        const { world, serverToLocal, localEid } = setup();
        const buf = new InterpolationBuffer(serverToLocal, 8, 100, 300);

        // Apply once with an initial snapshot so World holds (0, 0).
        buf.record(snap(1000, 1, [{ serverEid: 100, comp: Position, value: { x: 0, y: 0 } }]));
        buf.apply(world, 1100, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(0);

        // 10 seconds later, activity resumes. Stale snapshot pruned.
        buf.record(snap(11000, 2, [{ serverEid: 100, comp: Position, value: { x: 100, y: 0 } }]));

        // Right when the snapshot arrives: renderTime = 11000 - 100 = 10900.
        // Buffer has only the new snapshot at t=11000. renderTime < 11000 →
        // underrun → hold the previous World value (0, 0). The peer
        // visually stays at their idle position until the delay elapses.
        buf.apply(world, 11000, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(0);

        // After the delay elapses: renderTime = 11150 - 100 = 11050 > 11000
        // → overrun → write the new snapshot's value.
        buf.apply(world, 11150, [Position], () => false);
        expect(world.get(localEid, Position).x).toBeCloseTo(100);
    });
});

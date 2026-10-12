import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { Timeline } from 'murow/core/timeline';
import { defineComponent, World } from 'murow/ecs';
import { SnapshotPool } from './snapshot-pool';
import { encodeDelta, decodeDelta } from './delta-codec';
import { networked } from '../components/sync-spec';

describe('SnapshotPool', () => {
    test('a recycled row comes back nulled and a recycled value object is reused', () => {
        const pool = new SnapshotPool();
        const map = pool.acquireMap();
        const row = pool.acquireRow(2);
        const v = pool.acquireValues();
        v.x = 7;
        row[0] = v;
        map.set(1, row);

        pool.release(map);

        const row2 = pool.acquireRow(2);
        expect(row2[0]).toBeNull();
        expect(row2[1]).toBeNull();
        const v2 = pool.acquireValues();
        expect(v2).toBe(v); // same object, recycled
        const map2 = pool.acquireMap();
        expect(map2.size).toBe(0);
    });

    test('timeline-driven release never recycles a still-live snapshot', () => {
        const pool = new SnapshotPool();
        const tl = new Timeline<{ v: Map<number, (Record<string, number> | null)[]> }>(2, 1e9);
        tl.onEvict = (s) => pool.release(s.v);

        for (let i = 0; i < 6; i++) {
            const map = pool.acquireMap();
            const row = pool.acquireRow(2);
            const val = pool.acquireValues();
            val.x = i;
            row[0] = val;
            map.set(1, row);
            tl.record(i, i, { v: map });
        }

        // Only the two newest survive; each must still hold its own value.
        expect(tl.length).toBe(2);
        for (let i = 0; i < tl.length; i++) {
            const e = tl.at(i);
            expect(e.sample.v.get(1)![0]!.x).toBe(e.tick);
        }
    });
});

describe('decodeDelta with a pool', () => {
    const Position = defineComponent('Position', {
        schema: { x: f32, y: f32 },
        sync: networked({ rate: 'every-tick', interest: 'global' }),
    });

    test('produces the same values with or without a pool, across reuse', () => {
        const server = new World({ maxEntities: 8, components: [Position] });
        const a = server.spawn();
        server.add(a, Position, { x: 1, y: 2 });
        const buf = encodeDelta(server, 1, [a], [Position], 1);

        const pool = new SnapshotPool();
        const client = new World({ maxEntities: 8, components: [Position] });
        const ce = client.spawn();

        for (let i = 0; i < 3; i++) {
            const decoded = decodeDelta(client, buf, [Position], 1, () => ce, () => false, pool);
            const row = decoded.valuesByServerEntity.get(a)!;
            expect(row[0]!.x).toBe(1);
            expect(row[0]!.y).toBe(2);
            // Return to the pool as an evicted snapshot would.
            pool.release(decoded.valuesByServerEntity);
        }
    });
});

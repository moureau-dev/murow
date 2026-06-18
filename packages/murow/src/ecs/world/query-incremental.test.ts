import { describe, test, expect } from 'bun:test';
import { World, type Entity } from './world';
import { defineComponent } from '../components/component';
import { f32, u16 } from '../../core/binary-codec';

const A = defineComponent('A', { x: f32 });
const B = defineComponent('B', { y: f32 });
const C = defineComponent('C', { z: u16 });

function makeWorld() {
    return new World({ maxEntities: 256, components: [A, B, C] });
}

const sortedQuery = (w: World, ...comps: any[]) => [...w.query(...comps)].sort((a, b) => a - b);

describe('incremental query maintenance', () => {
    test('a query registered before any entities still sees entities added later', () => {
        const w = makeWorld();
        expect(sortedQuery(w, A)).toEqual([]); // registers the cache while empty

        const e = w.spawn();
        w.add(e, A, { x: 1 });
        expect(sortedQuery(w, A)).toEqual([e]);
    });

    test('a query registered after population sees the prior entities (lazy full scan)', () => {
        const w = makeWorld();
        const ids: Entity[] = [];
        for (let i = 0; i < 10; i++) {
            const e = w.spawn();
            w.add(e, A, { x: i });
            ids.push(e);
        }
        // first query of this mask happens now -> must capture all existing
        expect(sortedQuery(w, A)).toEqual(ids.sort((a, b) => a - b));
    });

    test('add inserts, remove drops, for multi-component queries', () => {
        const w = makeWorld();
        const e = w.spawn();
        w.add(e, A, { x: 1 });
        expect(sortedQuery(w, A, B)).toEqual([]); // missing B

        w.add(e, B, { y: 1 });
        expect(sortedQuery(w, A, B)).toEqual([e]); // now matches

        w.remove(e, B);
        expect(sortedQuery(w, A, B)).toEqual([]); // dropped
        expect(sortedQuery(w, A)).toEqual([e]); // still in A
    });

    test('despawn removes the entity from every query it was in', () => {
        const w = makeWorld();
        const e = w.spawn();
        w.add(e, A, { x: 1 });
        w.add(e, B, { y: 1 });
        expect(sortedQuery(w, A)).toEqual([e]);
        expect(sortedQuery(w, A, B)).toEqual([e]);

        w.despawn(e);
        expect(sortedQuery(w, A)).toEqual([]);
        expect(sortedQuery(w, A, B)).toEqual([]);
    });

    test('a recycled entity id does not leak into a query until it qualifies again', () => {
        const w = makeWorld();
        const e1 = w.spawn();
        w.add(e1, A, { x: 1 });
        expect(sortedQuery(w, A)).toEqual([e1]);

        w.despawn(e1);
        const e2 = w.spawn(); // very likely reuses e1's id
        expect(sortedQuery(w, A)).toEqual([]); // fresh entity has no components -> not in A

        w.add(e2, A, { x: 2 });
        expect(sortedQuery(w, A)).toEqual([e2]);
    });

    test('swap-remove keeps the buffer consistent when despawning from the middle', () => {
        const w = makeWorld();
        const ids: Entity[] = [];
        for (let i = 0; i < 20; i++) {
            const e = w.spawn();
            w.add(e, A, { x: i });
            ids.push(e);
        }
        // despawn a middle chunk
        for (const e of ids.slice(5, 15)) w.despawn(e);

        const remaining = [...ids.slice(0, 5), ...ids.slice(15)].sort((a, b) => a - b);
        const result = sortedQuery(w, A);
        expect(result).toEqual(remaining);
        expect(new Set(result).size).toBe(result.length); // no duplicates from swap-remove
    });

    test('fuzz: query result always equals a brute-force scan after every op', () => {
        const w = makeWorld();
        const alive = new Set<Entity>();
        let seed = 0x12345;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const pick = () => [...alive][Math.floor(rand() * alive.size)]!;

        // register all masks up front so maintenance (not just registration) is exercised
        w.query(A); w.query(B); w.query(C); w.query(A, B); w.query(A, B, C);

        const brute = (...comps: any[]) =>
            [...alive].filter((e) => comps.every((c) => w.has(e, c))).sort((a, b) => a - b);
        const check = () => {
            expect(sortedQuery(w, A)).toEqual(brute(A));
            expect(sortedQuery(w, B)).toEqual(brute(B));
            expect(sortedQuery(w, C)).toEqual(brute(C));
            expect(sortedQuery(w, A, B)).toEqual(brute(A, B));
            expect(sortedQuery(w, A, B, C)).toEqual(brute(A, B, C));
        };

        for (let step = 0; step < 3000; step++) {
            const r = rand();
            if (r < 0.4 && alive.size < 200) {
                const e = w.spawn();
                alive.add(e);
                if (rand() < 0.7) w.add(e, A, { x: 1 });
                if (rand() < 0.5) w.add(e, B, { y: 1 });
                if (rand() < 0.3) w.add(e, C, { z: 1 });
            } else if (r < 0.6 && alive.size > 0) {
                const e = pick();
                if (!w.has(e, A)) w.add(e, A, { x: 1 });
                else if (!w.has(e, B)) w.add(e, B, { y: 1 });
                else if (!w.has(e, C)) w.add(e, C, { z: 1 });
            } else if (r < 0.78 && alive.size > 0) {
                const e = pick();
                if (w.has(e, A)) w.remove(e, A);
                else if (w.has(e, B)) w.remove(e, B);
            } else if (alive.size > 0) {
                const e = pick();
                w.despawn(e);
                alive.delete(e);
            }
            check();
        }
    });

    test('single-component query reflects the maintained member list', () => {
        const w = makeWorld();
        const e1 = w.spawn();
        const e2 = w.spawn();
        w.add(e1, A, { x: 1 });
        w.add(e2, A, { x: 2 });
        expect(sortedQuery(w, A)).toEqual([e1, e2].sort((a, b) => a - b));

        w.remove(e1, A);
        expect(sortedQuery(w, A)).toEqual([e2]);

        w.despawn(e2);
        expect(sortedQuery(w, A)).toEqual([]);
    });

    test('multi-component query first registered on a populated, churned world matches a brute scan', () => {
        const w = makeWorld();
        const alive = new Set<Entity>();
        let seed = 0xbeef;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

        // Build a churned world WITHOUT ever querying, so the first query() below
        // registers against a populated world (exercises lead-with-smallest).
        for (let i = 0; i < 200; i++) {
            const e = w.spawn();
            alive.add(e);
            if (rand() < 0.9) w.add(e, A, { x: 1 });
            if (rand() < 0.3) w.add(e, B, { y: 1 }); // B is the selective component
            if (rand() < 0.6) w.add(e, C, { z: 1 });
        }
        for (const e of [...alive]) {
            if (rand() < 0.2) { w.despawn(e); alive.delete(e); }
            else if (rand() < 0.3 && w.has(e, A)) w.remove(e, A);
        }

        const brute = (...comps: any[]) =>
            [...alive].filter((e) => comps.every((c) => w.has(e, c))).sort((a, b) => a - b);

        // First-ever query of each mask -> registration scans the smallest member list.
        expect(sortedQuery(w, A, B)).toEqual(brute(A, B));
        expect(sortedQuery(w, B, C)).toEqual(brute(B, C));
        expect(sortedQuery(w, A, B, C)).toEqual(brute(A, B, C));
        expect(sortedQuery(w, A)).toEqual(brute(A));
    });
});

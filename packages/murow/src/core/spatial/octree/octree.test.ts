import { describe, expect, test } from 'bun:test';
import { Octree } from './octree';

const box3 = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) =>
    ({ minX, minY, minZ, maxX, maxY, maxZ });
const tree = () => new Octree({ bounds: box3(0, 0, 0, 100, 100, 100), maxItems: 2, maxDepth: 6 });

describe('Octree', () => {
    test('subdivides and returns overlapping ids once each', () => {
        const o = tree();
        for (let i = 0; i < 10; i++) o.insert(i, box3(i, i, i, i, i, i));
        const out: number[] = [];
        o.query(box3(0, 0, 0, 20, 20, 20), out);
        expect(out.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(o.size).toBe(10);
        o.query(box3(80, 80, 80, 100, 100, 100), out);
        expect(out).toEqual([]);
    });

    test('isolates by z', () => {
        const o = tree();
        o.insert(1, box3(10, 10, 10, 10, 10, 10));
        o.insert(2, box3(10, 10, 90, 10, 10, 90));
        const out: number[] = [];
        o.query(box3(0, 0, 0, 20, 20, 20), out);
        expect(out).toEqual([1]);
        o.query(box3(0, 0, 80, 20, 20, 100), out);
        expect(out).toEqual([2]);
    });

    test('update, remove, clear', () => {
        const o = tree();
        o.insert(1, box3(10, 10, 10, 10, 10, 10));
        o.update(1, box3(90, 90, 90, 90, 90, 90));
        const out: number[] = [];
        o.query(box3(0, 0, 0, 20, 20, 20), out);
        expect(out).toEqual([]);
        o.query(box3(85, 85, 85, 95, 95, 95), out);
        expect(out).toEqual([1]);
        o.remove(1);
        expect(o.size).toBe(0);
        o.insert(2, box3(10, 10, 10, 10, 10, 10));
        o.clear();
        o.query(box3(0, 0, 0, 20, 20, 20), out);
        expect(out).toEqual([]);
    });
});

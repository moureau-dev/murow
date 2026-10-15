import { describe, expect, test } from 'bun:test';
import { Quadtree } from './quadtree';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
const tree = () => new Quadtree({ bounds: box(0, 0, 100, 100), capacity: 64, maxItems: 2, maxDepth: 6 });

describe('Quadtree', () => {
    test('subdivides and still returns overlapping ids once each', () => {
        const q = tree();
        // Cluster many points in the top-left quadrant to force subdivision.
        for (let i = 0; i < 12; i++) q.insert(i, box(i, i, i, i));
        const out: number[] = [];
        q.query(box(0, 0, 20, 20), out);
        expect(out.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(q.size).toBe(12);

        q.query(box(80, 80, 100, 100), out);
        expect(out).toEqual([]);
    });

    test('query returns only overlapping ids', () => {
        const q = tree();
        q.insert(1, box(10, 10, 10, 10));
        q.insert(2, box(90, 90, 90, 90));
        q.insert(3, box(50, 10, 60, 20));
        const out: number[] = [];
        q.query(box(0, 0, 30, 30), out);
        expect(out.sort((a, b) => a - b)).toEqual([1]);
        q.query(box(45, 5, 65, 25), out);
        expect(out.sort((a, b) => a - b)).toEqual([3]);
    });

    test('update, remove, clear', () => {
        const q = tree();
        q.insert(1, box(10, 10, 10, 10));
        q.update(1, box(90, 90, 90, 90));
        const out: number[] = [];
        q.query(box(0, 0, 30, 30), out);
        expect(out).toEqual([]);
        q.query(box(85, 85, 95, 95), out);
        expect(out).toEqual([1]);
        q.remove(1);
        expect(q.size).toBe(0);
        q.insert(2, box(10, 10, 10, 10));
        q.clear();
        q.query(box(0, 0, 30, 30), out);
        expect(out).toEqual([]);
    });
});

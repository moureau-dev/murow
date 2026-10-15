import { describe, expect, test } from 'bun:test';
import { SpatialGrid } from './spatial-grid';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
const grid = () => new SpatialGrid({ bounds: box(0, 0, 100, 100), cellSize: 10, capacity: 16 });

describe('SpatialGrid', () => {
    test('returns ids whose cell overlaps the query', () => {
        const g = grid();
        g.insert(1, box(5, 5, 5, 5));
        g.insert(2, box(55, 55, 55, 55));
        const out: number[] = [];
        g.query(box(0, 0, 9, 9), out);
        expect(out).toEqual([1]);
        g.query(box(50, 50, 60, 60), out);
        expect(out).toEqual([2]);
        expect(g.size).toBe(2);
    });

    test('update moves, remove drops, size tracks', () => {
        const g = grid();
        g.insert(1, box(5, 5, 5, 5));
        g.update(1, box(55, 55, 55, 55));
        const out: number[] = [];
        g.query(box(0, 0, 9, 9), out);
        expect(out).toEqual([]);
        g.query(box(50, 50, 60, 60), out);
        expect(out).toEqual([1]);
        g.remove(1);
        g.query(box(50, 50, 60, 60), out);
        expect(out).toEqual([]);
        expect(g.size).toBe(0);
    });

    test('a multi-cell box is returned once per query', () => {
        const g = grid();
        g.insert(1, box(5, 5, 25, 25));
        const out: number[] = [];
        g.query(box(0, 0, 100, 100), out);
        expect(out).toEqual([1]);
    });

    test('query returns every id whose cell intersects', () => {
        const g = grid();
        for (let i = 0; i < 5; i++) g.insert(i, box(i * 15, i * 15, i * 15, i * 15));
        const out: number[] = [];
        g.query(box(0, 0, 100, 100), out);
        expect(out.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
        g.clear();
        expect(g.size).toBe(0);
        g.query(box(0, 0, 100, 100), out);
        expect(out).toEqual([]);
    });
});

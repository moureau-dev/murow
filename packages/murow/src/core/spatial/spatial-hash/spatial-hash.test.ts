import { describe, expect, test } from 'bun:test';
import { SpatialHash } from './spatial-hash';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
const hash = () => new SpatialHash({ cellSize: 10, capacity: 16, buckets: 64 });

describe('SpatialHash', () => {
    test('handles negative and unbounded coordinates', () => {
        const h = hash();
        h.insert(1, box(-95, -95, -95, -95));
        h.insert(2, box(1000, 1000, 1000, 1000));
        const out: number[] = [];
        h.query(box(-100, -100, -90, -90), out);
        expect(out).toEqual([1]);
        h.query(box(995, 995, 1005, 1005), out);
        expect(out).toEqual([2]);
        expect(h.size).toBe(2);
    });

    test('update, remove, clear', () => {
        const h = hash();
        h.insert(3, box(0, 0, 0, 0));
        h.update(3, box(500, 500, 500, 500));
        const out: number[] = [];
        h.query(box(0, 0, 5, 5), out);
        expect(out).toEqual([]);
        h.query(box(495, 495, 505, 505), out);
        expect(out).toEqual([3]);
        h.remove(3);
        expect(h.size).toBe(0);
        h.insert(4, box(0, 0, 0, 0));
        h.clear();
        h.query(box(0, 0, 5, 5), out);
        expect(out).toEqual([]);
    });
});

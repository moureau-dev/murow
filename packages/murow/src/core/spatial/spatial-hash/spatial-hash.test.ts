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

    test('queryRay walks the cells a ray crosses', () => {
        const h = hash();
        h.insert(1, box(5, 5, 5, 5));    // cell (0,0)
        h.insert(2, box(25, 5, 25, 5));  // cell (2,0)
        h.insert(3, box(25, 95, 25, 95)); // far off the ray
        const out: number[] = [];

        // Ray along +x from (0,0) for 40 units crosses cells (0,0) and (1,0), (2,0).
        h.queryRay(0, 0, 1, 0, 40, out);
        expect(out).toContain(1);
        expect(out).toContain(2);
        expect(out).not.toContain(3);

        // Short ray that stops before cell (2,0).
        h.queryRay(0, 0, 1, 0, 15, out);
        expect(out).toContain(1);
        expect(out).not.toContain(2);
    });
});

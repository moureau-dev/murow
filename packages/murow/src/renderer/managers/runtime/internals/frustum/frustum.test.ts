import { test, expect, describe } from 'bun:test';
import { Frustum } from './frustum';

/** Identity view-projection → the visible region is the box [-1, 1]³. */
const identity = () => {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
};

describe('Frustum', () => {
    test('sphere at origin is visible under identity', () => {
        const f = new Frustum();
        f.setFromViewProjection(identity());
        expect(f.intersectsSphere(0, 0, 0, 0.5)).toBe(true);
    });

    test('sphere far outside is culled', () => {
        const f = new Frustum();
        f.setFromViewProjection(identity());
        expect(f.intersectsSphere(5, 0, 0, 0.5)).toBe(false);
        expect(f.intersectsSphere(0, -5, 0, 0.5)).toBe(false);
        expect(f.intersectsSphere(0, 0, 5, 0.5)).toBe(false);
    });

    test('sphere straddling a plane intersects (visible)', () => {
        const f = new Frustum();
        f.setFromViewProjection(identity());
        // left plane is x >= -1; centre at -1.4 with r=0.5 still overlaps
        expect(f.intersectsSphere(-1.4, 0, 0, 0.5)).toBe(true);
        // fully past the plane
        expect(f.intersectsSphere(-2, 0, 0, 0.5)).toBe(false);
    });

    test('recomputes planes on each set, no stale state', () => {
        const f = new Frustum();
        f.setFromViewProjection(identity());
        expect(f.intersectsSphere(5, 0, 0, 0.5)).toBe(false);

        // scale the matrix so the visible box grows to [-10, 10]³
        const m = new Float32Array(16);
        m[0] = 0.1; m[5] = 0.1; m[10] = 0.1; m[15] = 1;
        f.setFromViewProjection(m);
        expect(f.intersectsSphere(5, 0, 0, 0.5)).toBe(true);
    });
});

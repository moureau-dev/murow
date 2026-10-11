import { describe, expect, test } from 'bun:test';
import { Frustum } from './frustum';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('Frustum', () => {
    test('contains a sphere at the origin', () => {
        const f = new Frustum();
        f.setFromViewProjection(identity);
        expect(f.intersectsSphere(0, 0, 0, 0.5)).toBe(true);
    });

    test('rejects a sphere far outside', () => {
        const f = new Frustum();
        f.setFromViewProjection(identity);
        expect(f.intersectsSphere(1e6, 0, 0, 0.5)).toBe(false);
    });
});

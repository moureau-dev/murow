import { test, expect, describe } from 'bun:test';
import { Frustum } from '../frustum/frustum';
import { SkinCull } from './skin-cull';

/** A frustum covering a large box ([-100, 100]³) for isolating the distance test. */
function wideFrustum(): Frustum {
    const m = new Float32Array(16);
    m[0] = 0.01; m[5] = 0.01; m[10] = 0.01; m[15] = 1;
    const f = new Frustum();
    f.setFromViewProjection(m);
    return f;
}

describe('SkinCull', () => {
    test('visible and near → update', () => {
        const cull = new SkinCull(wideFrustum(), 10);
        expect(cull.shouldUpdate(0, 0, 0, 0.5, 0, 0, 0)).toBe(true);
        expect(cull.shouldUpdate(5, 0, 0, 0.5, 0, 0, 0)).toBe(true);
    });

    test('visible but beyond distance → culled', () => {
        const cull = new SkinCull(wideFrustum(), 10);
        expect(cull.shouldUpdate(50, 0, 0, 0.5, 0, 0, 0)).toBe(false);
    });

    test('near but outside the frustum → culled', () => {
        const cull = new SkinCull(wideFrustum(), 10);
        expect(cull.shouldUpdate(500, 0, 0, 0.5, 0, 0, 0)).toBe(false);
    });

    test('setDistance updates the budget', () => {
        const cull = new SkinCull(wideFrustum(), 10);
        expect(cull.shouldUpdate(50, 0, 0, 0.5, 0, 0, 0)).toBe(false);
        cull.setDistance(100);
        expect(cull.shouldUpdate(50, 0, 0, 0.5, 0, 0, 0)).toBe(true);
        expect(cull.distance).toBe(100);
    });
});

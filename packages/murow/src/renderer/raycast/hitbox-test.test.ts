import { test, expect } from 'bun:test';
import { Ray3D } from '../../core/ray/ray-3d';
import { testHitbox3DRay, testHitbox2DPoint, testQuad2DPoint } from './hitbox-test';
import type { Hitbox2D } from '../prefab-bucket/specs';

test('testHitbox3DRay applies scale and offset to a sphere', () => {
    const ray = new Ray3D();
    ray.set(0, 0, 0, 0, 0, 1);
    // Sphere radius 1 at z=10, scaled 2x -> radius 2, entry at 8.
    const t = testHitbox3DRay(ray, { shape: 'sphere', radius: 1 }, 0, 0, 10, 2, 2, 2);
    expect(t).toBeCloseTo(8);
});

test('testQuad2DPoint: inside vs outside the rendered quad', () => {
    // 4x2 quad centered at (10, 5).
    expect(testQuad2DPoint(10, 5, 4, 2, 0, 11, 5)).toBe(true);
    expect(testQuad2DPoint(10, 5, 4, 2, 0, 13, 5)).toBe(false);
    expect(testQuad2DPoint(10, 5, 4, 2, 0, 10, 5.5)).toBe(true);
    expect(testQuad2DPoint(10, 5, 4, 2, 0, 10, 6.5)).toBe(false);
});

test('testQuad2DPoint respects rotation', () => {
    // 4x1 quad at origin, rotated 90deg: now spans 1 wide in x, 4 tall in y.
    const rot = Math.PI / 2;
    expect(testQuad2DPoint(0, 0, 4, 1, rot, 0, 1.8)).toBe(true);
    expect(testQuad2DPoint(0, 0, 4, 1, rot, 1.8, 0)).toBe(false);
});

test('testHitbox2DPoint circle uses the larger scale axis', () => {
    const hb: Hitbox2D = { shape: 'circle', radius: 1 };
    // scaled 3x in x -> radius 3.
    expect(testHitbox2DPoint(hb, 0, 0, 3, 1, 0, 2.5, 0)).toBe(true);
    expect(testHitbox2DPoint(hb, 0, 0, 3, 1, 0, 3.5, 0)).toBe(false);
});

test('testHitbox2DPoint capsule hits along its body and caps', () => {
    // radius 1, length 6 -> body spans y in [-3, 3], caps extend to +-4.
    const hb: Hitbox2D = { shape: 'capsule', radius: 1, length: 6 };
    expect(testHitbox2DPoint(hb, 0, 0, 1, 1, 0, 0.9, 2)).toBe(true);   // body
    expect(testHitbox2DPoint(hb, 0, 0, 1, 1, 0, 0, 3.9)).toBe(true);   // cap
    expect(testHitbox2DPoint(hb, 0, 0, 1, 1, 0, 0, 4.1)).toBe(false);  // past cap
    expect(testHitbox2DPoint(hb, 0, 0, 1, 1, 0, 1.5, 0)).toBe(false);  // outside radius
});

test('testHitbox2DPoint applies offset in local space', () => {
    const hb: Hitbox2D = { shape: 'circle', radius: 1, offset: [5, 0] };
    expect(testHitbox2DPoint(hb, 0, 0, 1, 1, 0, 5, 0)).toBe(true);
    expect(testHitbox2DPoint(hb, 0, 0, 1, 1, 0, 0, 0)).toBe(false);
});

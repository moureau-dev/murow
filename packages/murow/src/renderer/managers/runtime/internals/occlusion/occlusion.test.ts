import { test, expect, describe } from 'bun:test';
import { Hzb, aabbVisible } from './hzb';

/** Identity view-projection: world maps straight to NDC with depth in [0, 1]. */
function identity(): Float32Array {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
}

/**
 * 4x4 depth buffer with a nearer (0.5) occluder filling the right half
 * (base columns 2 and 3); the rest stays at the far value (1).
 */
function occludedHzb(): Hzb {
    const hzb = new Hzb(4, 4);
    hzb.clear(1);
    for (let y = 0; y < 4; y++) {
        hzb.set(2, y, 0.5);
        hzb.set(3, y, 0.5);
    }
    hzb.reduce();
    return hzb;
}

describe('Hzb', () => {
    test('allocates a halving pyramid down to 1x1', () => {
        const hzb = new Hzb(4, 4);
        expect(hzb.levels.length).toBe(3);
        expect(Array.from(hzb.levelWidths)).toEqual([4, 2, 1]);
        expect(Array.from(hzb.levelHeights)).toEqual([4, 2, 1]);
    });

    test('max-reduces each level from its children', () => {
        const hzb = new Hzb(2, 2);
        hzb.set(0, 0, 0.1);
        hzb.set(1, 0, 0.2);
        hzb.set(0, 1, 0.3);
        hzb.set(1, 1, 0.4);
        hzb.reduce();
        expect(hzb.levels[1]![0]).toBeCloseTo(0.4);
    });

    test('build copies a base depth slice and reduces', () => {
        const hzb = new Hzb(2, 2);
        const depth = new Float32Array([0.2, 0.4, 0.6, 0.8]);
        hzb.build(depth);
        expect(hzb.get(1, 1)).toBeCloseTo(0.8);
        expect(hzb.levels[1]![0]).toBeCloseTo(0.8);
    });
});

describe('aabbVisible', () => {
    test('a box in front of the occluder is visible', () => {
        const hzb = occludedHzb();
        // Overlaps the occluder column but is nearer (z 0.2..0.4 < 0.5).
        expect(aabbVisible(hzb, identity(), 0.5, 0, 0.3, 0.1, 0.1, 0.1)).toBe(true);
    });

    test('a box fully behind the occluder is culled', () => {
        const hzb = occludedHzb();
        // Covers the occluder column at z 0.8..1.0, farther than 0.5.
        expect(aabbVisible(hzb, identity(), 0.5, 0, 0.9, 0.1, 0.1, 0.1)).toBe(false);
    });

    test('a box beside the occluder is visible', () => {
        const hzb = occludedHzb();
        // Left half (base columns 0 and 1) is empty, so nothing is in front.
        expect(aabbVisible(hzb, identity(), -0.5, 0, 0.9, 0.1, 0.1, 0.1)).toBe(true);
    });

    test('a box with occlusion=false is never culled', () => {
        const hzb = occludedHzb();
        // Same box as the culled case, but the per-instance opt-out forces visible.
        expect(aabbVisible(hzb, identity(), 0.5, 0, 0.9, 0.1, 0.1, 0.1, false)).toBe(true);
    });

    test('a box behind the near plane is kept conservatively', () => {
        const hzb = occludedHzb();
        const flipZ = new Float32Array(16);
        flipZ[0] = 1; flipZ[5] = 1; flipZ[10] = -1; flipZ[15] = 1;
        expect(aabbVisible(hzb, flipZ, 0.5, 0, 0.9, 0.1, 0.1, 0.1)).toBe(true);
    });
});

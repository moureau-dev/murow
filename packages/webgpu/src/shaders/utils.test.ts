import { test, expect, describe } from 'bun:test';
import * as d from 'typegpu/data';
import { rotate2d, worldToClip2d, worldToClip3d, remap, scaleRotate2d, inverseLerp } from './utils';

describe('shader utils (CPU execution)', () => {
    describe('rotate2d', () => {
        test('0 angle returns same point', () => {
            const result = rotate2d(d.vec2f(1, 0), 0);
            expect(result.x).toBeCloseTo(1);
            expect(result.y).toBeCloseTo(0);
        });

        test('90 degrees rotates correctly', () => {
            const result = rotate2d(d.vec2f(1, 0), Math.PI / 2);
            expect(result.x).toBeCloseTo(0);
            expect(result.y).toBeCloseTo(1);
        });

        test('180 degrees flips', () => {
            const result = rotate2d(d.vec2f(1, 0), Math.PI);
            expect(result.x).toBeCloseTo(-1);
            expect(result.y).toBeCloseTo(0);
        });

        test('rotates arbitrary point', () => {
            const result = rotate2d(d.vec2f(0, 1), -Math.PI / 2);
            expect(result.x).toBeCloseTo(1);
            expect(result.y).toBeCloseTo(0);
        });
    });

    describe('remap', () => {
        test('midpoint maps correctly', () => {
            expect(remap(0.5, 0, 1, 10, 20)).toBeCloseTo(15);
        });

        test('min maps to outMin', () => {
            expect(remap(0, 0, 1, 10, 20)).toBeCloseTo(10);
        });

        test('max maps to outMax', () => {
            expect(remap(1, 0, 1, 10, 20)).toBeCloseTo(20);
        });

        test('works with negative ranges', () => {
            expect(remap(0, -1, 1, 0, 100)).toBeCloseTo(50);
        });
    });

    describe('inverseLerp', () => {
        test('midpoint returns 0.5', () => {
            expect(inverseLerp(0, 10, 5)).toBeCloseTo(0.5);
        });

        test('min returns 0', () => {
            expect(inverseLerp(0, 10, 0)).toBeCloseTo(0);
        });

        test('max returns 1', () => {
            expect(inverseLerp(0, 10, 10)).toBeCloseTo(1);
        });

        test('clamps below to 0', () => {
            expect(inverseLerp(0, 10, -5)).toBeCloseTo(0);
        });

        test('clamps above to 1', () => {
            expect(inverseLerp(0, 10, 15)).toBeCloseTo(1);
        });
    });

    describe('scaleRotate2d', () => {
        test('identity at scale 1, angle 0', () => {
            const m = scaleRotate2d(d.vec2f(1, 1), 0);
            // Should be identity-ish: [[1, 0], [0, 1]]
            expect(m[0]).toBeCloseTo(1);
            expect(m[1]).toBeCloseTo(0);
            expect(m[2]).toBeCloseTo(0);
            expect(m[3]).toBeCloseTo(1);
        });

        test('scale 2x with no rotation', () => {
            const m = scaleRotate2d(d.vec2f(2, 2), 0);
            expect(m[0]).toBeCloseTo(2);
            expect(m[3]).toBeCloseTo(2);
        });

        test('90 degree rotation with unit scale', () => {
            const m = scaleRotate2d(d.vec2f(1, 1), Math.PI / 2);
            // cos(90)=0, sin(90)=1 → [[0, 1], [-1, 0]]
            expect(m[0]).toBeCloseTo(0);
            expect(m[1]).toBeCloseTo(1);
            expect(m[2]).toBeCloseTo(-1);
            expect(m[3]).toBeCloseTo(0);
        });
    });

    describe('worldToClip2d', () => {
        test('is a callable tgpu function', () => {
            // Matrix * vector ops require GPU-side execution in TypeGPU.
            // Verify the function exists and is properly typed.
            expect(typeof worldToClip2d).toBe('function');
        });
    });

    describe('worldToClip3d', () => {
        test('is a callable tgpu function', () => {
            expect(typeof worldToClip3d).toBe('function');
        });
    });
});

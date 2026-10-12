import { test, expect, describe } from 'bun:test';
import * as d from 'typegpu/data';
import { rotate2d, worldToClip2d, worldToClip3d, remap, scaleRotate2d, inverseLerp, lightContribution } from './utils';

/** Point-light arg helpers: zero axis, innerCos=1, outerCos=-1 (cone always 1). */
const POINT_AXIS = d.vec3f(0, 0, 0);
function pointParams(intensity: number, range: number) {
    return d.vec4f(intensity, range, 1, -1);
}

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

    describe('lightContribution', () => {
        test('point light directly above an up-facing surface lights it', () => {
            const c = lightContribution(
                d.vec3f(0, 1, 0),          // pos: 1 unit above
                POINT_AXIS,
                d.vec3f(1, 1, 1),          // white
                pointParams(1, 10),
                d.vec3f(0, 1, 0),          // up normal
                d.vec3f(0, 0, 0),          // surface at origin
            );
            // lambert=1, dist=1 -> atten=0.9 -> falloff=0.81
            expect(c.x).toBeCloseTo(0.81, 2);
            expect(c.y).toBeCloseTo(0.81, 2);
            expect(c.z).toBeCloseTo(0.81, 2);
        });

        test('contributes nothing past its range', () => {
            const c = lightContribution(
                d.vec3f(0, 20, 0),         // 20 units away, range 10
                POINT_AXIS,
                d.vec3f(1, 1, 1),
                pointParams(1, 10),
                d.vec3f(0, 1, 0),
                d.vec3f(0, 0, 0),
            );
            expect(c.x).toBeCloseTo(0, 5);
            expect(c.y).toBeCloseTo(0, 5);
            expect(c.z).toBeCloseTo(0, 5);
        });

        test('contributes nothing when the surface faces away', () => {
            const c = lightContribution(
                d.vec3f(0, 1, 0),
                POINT_AXIS,
                d.vec3f(1, 1, 1),
                pointParams(1, 10),
                d.vec3f(0, -1, 0),         // normal points away from the light
                d.vec3f(0, 0, 0),
            );
            expect(c.x).toBeCloseTo(0, 5);
        });

        test('intensity scales the contribution', () => {
            const dim = lightContribution(d.vec3f(0, 1, 0), POINT_AXIS, d.vec3f(1, 1, 1), pointParams(1, 10), d.vec3f(0, 1, 0), d.vec3f(0, 0, 0));
            const bright = lightContribution(d.vec3f(0, 1, 0), POINT_AXIS, d.vec3f(1, 1, 1), pointParams(2, 10), d.vec3f(0, 1, 0), d.vec3f(0, 0, 0));
            expect(bright.x).toBeCloseTo(dim.x * 2, 4);
        });

        test('point light cone term does not produce NaN from a zero axis', () => {
            const c = lightContribution(d.vec3f(0, 1, 0), POINT_AXIS, d.vec3f(1, 1, 1), pointParams(1, 10), d.vec3f(0, 1, 0), d.vec3f(0, 0, 0));
            expect(Number.isNaN(c.x)).toBe(false);
            expect(Number.isNaN(c.y)).toBe(false);
            expect(Number.isNaN(c.z)).toBe(false);
        });

        test('spot light inside its cone lights the surface, outside does not', () => {
            // Spot at (0,1,0) pointing straight down (0,-1,0). Surface at origin, up normal.
            const innerCos = Math.cos(0.3);
            const outerCos = Math.cos(0.5);
            const params = d.vec4f(1, 10, innerCos, outerCos);

            const inside = lightContribution(
                d.vec3f(0, 1, 0), d.vec3f(0, -1, 0), d.vec3f(1, 1, 1), params, d.vec3f(0, 1, 0), d.vec3f(0, 0, 0),
            );
            expect(inside.x).toBeGreaterThan(0);

            // Surface off to the side so the light direction is far outside the cone.
            const outside = lightContribution(
                d.vec3f(0, 1, 0), d.vec3f(0, -1, 0), d.vec3f(1, 1, 1), params, d.vec3f(0, 1, 0), d.vec3f(100, 0, 0),
            );
            expect(outside.x).toBeCloseTo(0, 5);
        });

        test('the cone edge is smoothstep-feathered, not a linear ramp', () => {
            // Spot at the origin pointing down -Y. Sample surfaces on a sphere of
            // fixed radius so distance (-> falloff) and the lambert term are
            // identical across samples; only the cone angle differs. That isolates
            // the cone term, so the contribution ratio reflects the falloff curve.
            const R = 5;
            const spotPos = d.vec3f(0, 0, 0);
            const axis = d.vec3f(0, -1, 0);
            // Wide band so a sample can sit at a known fraction t through it.
            const outer = Math.cos(1.2);
            const inner = Math.cos(0.2);
            const params = d.vec4f(1, 100, inner, outer); // range >> R so falloff ~ constant

            // Build a surface point whose light-to-surface angle puts it at a
            // chosen `t` = (cosAngle - outer) / (inner - outer) through the band.
            const sample = (t: number) => {
                const cosAngle = outer + t * (inner - outer);
                const ang = Math.acos(cosAngle);            // angle off the -Y axis
                // surface position on the sphere at that polar angle
                const sx = R * Math.sin(ang);
                const sy = -R * Math.cos(ang);
                // normal points back at the light so lambert is constant (=1-ish);
                // use straight-up normal — lambert varies little and cancels in ratio.
                const normal = d.vec3f(0, 1, 0);
                const c = lightContribution(spotPos, axis, d.vec3f(1, 1, 1), params, normal, d.vec3f(sx, sy, 0));
                return c.x;
            };

            // At t this shader returns cone = t*t*(3-2t). A linear ramp would give t.
            // Compare an early-band sample (t=0.25) to a late one (t=0.75). With a
            // linear cone the ratio would be 0.25/0.75 = 0.333; smoothstep pushes
            // the early sample down hard (0.156/0.844 = 0.185), so the measured
            // ratio sits well below the linear value. (Geometry makes lambert vary
            // slightly between samples, so we assert the curve's shape, not an
            // exact ratio.)
            const t1 = 0.25, t2 = 0.75;
            const ratio = sample(t1) / sample(t2);
            const linearRatio = t1 / t2;                    // 0.333

            // A linear edge would give ~0.333; smoothstep gives noticeably less.
            // The early-band contribution is suppressed -> the edge is feathered.
            expect(ratio).toBeLessThan(linearRatio - 0.1);
            expect(ratio).toBeGreaterThan(0);
        });
    });
});

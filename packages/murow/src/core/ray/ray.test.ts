import { test, expect, describe } from 'bun:test';
import { Ray2D } from './Ray2D';
import { Ray3D } from './Ray3D';

// ─── Ray2D ───────────────────────────────────────────────────────────────────

describe('Ray2D', () => {
    describe('set', () => {
        test('normalizes direction', () => {
            const r = new Ray2D();
            r.set(0, 0, 3, 0);
            expect(r.direction[0]).toBeCloseTo(1);
            expect(r.direction[1]).toBeCloseTo(0);
        });

        test('sets origin', () => {
            const r = new Ray2D();
            r.set(2, 5, 1, 0);
            expect(r.origin[0]).toBe(2);
            expect(r.origin[1]).toBe(5);
        });

        test('normalizes diagonal direction', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 1);
            expect(r.direction[0]).toBeCloseTo(Math.SQRT1_2);
            expect(r.direction[1]).toBeCloseTo(Math.SQRT1_2);
        });
    });

    describe('at', () => {
        test('returns origin at t=0', () => {
            const r = new Ray2D();
            r.set(2, 3, 1, 0);
            const p = r.at(0);
            expect(p[0]).toBeCloseTo(2);
            expect(p[1]).toBeCloseTo(3);
        });

        test('advances along direction', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const p = r.at(5);
            expect(p[0]).toBeCloseTo(5);
            expect(p[1]).toBeCloseTo(0);
        });

        test('reuses internal buffer', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const p1 = r.at(1);
            const p2 = r.at(2);
            expect(p1).toBe(p2); // same reference
        });
    });

    describe('intersectsSegment', () => {
        test('hits perpendicular segment', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsSegment(5, -1, 5, 1);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(5);
        });

        test('misses parallel segment', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsSegment(0, 1, 10, 1);
            expect(t).toBeNull();
        });

        test('misses segment behind ray', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsSegment(-5, -1, -5, 1);
            expect(t).toBeNull();
        });

        test('misses segment that does not span ray path', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsSegment(5, 2, 5, 4); // segment above ray
            expect(t).toBeNull();
        });
    });

    describe('intersectsCircle', () => {
        test('hits circle head-on', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsCircle(5, 0, 1);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(4);
        });

        test('misses circle to the side', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsCircle(5, 3, 1);
            expect(t).toBeNull();
        });

        test('misses circle behind ray', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsCircle(-5, 0, 1);
            expect(t).toBeNull();
        });

        test('grazes circle tangentially', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsCircle(5, 1, 1);
            expect(t).not.toBeNull();
        });

        test('origin inside circle returns exit point', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsCircle(0, 0, 2);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(2);
        });
    });

    describe('intersectsAABB', () => {
        test('hits box from the left', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsAABB(4, -1, 6, 1);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(4);
        });

        test('misses box above', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsAABB(4, 2, 6, 4);
            expect(t).toBeNull();
        });

        test('misses box behind ray', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 0);
            const t = r.intersectsAABB(-6, -1, -4, 1);
            expect(t).toBeNull();
        });

        test('diagonal ray hits corner of box', () => {
            const r = new Ray2D();
            r.set(0, 0, 1, 1);
            const t = r.intersectsAABB(4, 4, 6, 6);
            expect(t).not.toBeNull();
        });

        test('axis-aligned ray parallel to box face — inside', () => {
            const r = new Ray2D();
            r.set(5, 0, 0, 1); // vertical ray through x=5
            const t = r.intersectsAABB(4, 2, 6, 8);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(2);
        });

        test('axis-aligned ray parallel to box face — outside', () => {
            const r = new Ray2D();
            r.set(10, 0, 0, 1); // vertical ray at x=10, box is x=4..6
            const t = r.intersectsAABB(4, 2, 6, 8);
            expect(t).toBeNull();
        });
    });
});

// ─── Ray3D ───────────────────────────────────────────────────────────────────

describe('Ray3D', () => {
    describe('set', () => {
        test('normalizes direction', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 5);
            expect(r.direction[2]).toBeCloseTo(1);
        });

        test('sets origin', () => {
            const r = new Ray3D();
            r.set(1, 2, 3, 0, 0, 1);
            expect(r.origin).toEqual([1, 2, 3]);
        });
    });

    describe('at', () => {
        test('advances along direction', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const p = r.at(7);
            expect(p[2]).toBeCloseTo(7);
        });

        test('reuses internal buffer', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            expect(r.at(1)).toBe(r.at(2));
        });
    });

    describe('intersectsPlane', () => {
        test('hits horizontal ground plane (y=0)', () => {
            const r = new Ray3D();
            r.set(0, 5, 0, 0, -1, 0); // shooting downward
            const t = r.intersectsPlane(0, 1, 0, 0); // n=(0,1,0), d=0
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(5);
        });

        test('misses parallel plane', () => {
            const r = new Ray3D();
            r.set(0, 1, 0, 1, 0, 0); // horizontal ray
            const t = r.intersectsPlane(0, 1, 0, 0);
            expect(t).toBeNull();
        });

        test('misses plane behind ray', () => {
            const r = new Ray3D();
            r.set(0, -5, 0, 0, -1, 0); // shooting further downward from below
            const t = r.intersectsPlane(0, 1, 0, 0);
            expect(t).toBeNull();
        });
    });

    describe('intersectsSphere', () => {
        test('hits sphere head-on', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsSphere(0, 0, 5, 1);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(4);
        });

        test('misses sphere to the side', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsSphere(5, 0, 5, 1);
            expect(t).toBeNull();
        });

        test('origin inside sphere returns exit', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsSphere(0, 0, 0, 2);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(2);
        });
    });

    describe('intersectsAABB', () => {
        test('hits box from front', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsAABB(-1, -1, 4, 1, 1, 6);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(4);
        });

        test('misses box to the side', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsAABB(2, -1, 4, 4, 1, 6);
            expect(t).toBeNull();
        });

        test('misses box behind ray', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsAABB(-1, -1, -6, 1, 1, -4);
            expect(t).toBeNull();
        });
    });

    describe('intersectsTriangle', () => {
        test('hits front-facing triangle', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            // triangle in XY plane at z=5
            const t = r.intersectsTriangle(-1, -1, 5, 1, -1, 5, 0, 1, 5);
            expect(t).not.toBeNull();
            expect(t!).toBeCloseTo(5);
        });

        test('misses triangle to the side', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsTriangle(5, 5, 3, 6, 5, 3, 5, 6, 3);
            expect(t).toBeNull();
        });

        test('misses triangle behind ray', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 0, 0, 1);
            const t = r.intersectsTriangle(-1, -1, -5, 1, -1, -5, 0, 1, -5);
            expect(t).toBeNull();
        });

        test('misses parallel triangle (coplanar ray)', () => {
            const r = new Ray3D();
            r.set(0, 0, 0, 1, 0, 0); // ray along X, triangle in XY plane
            const t = r.intersectsTriangle(0, 0, 0, 2, 0, 0, 1, 2, 0);
            expect(t).toBeNull();
        });
    });
});

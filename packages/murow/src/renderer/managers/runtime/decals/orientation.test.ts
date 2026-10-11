import { test, expect, describe } from 'bun:test';
import { decalEuler, applyEulerXYZ } from './orientation';

describe('decalEuler', () => {
    const normals: Array<[number, number, number]> = [
        [0, 1, 0],
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
        [0.4, 1, 0.35],
        [1, 1, 1],
        [0.5, -0.2, 0.8],
    ];

    test('points a +Z quad along the normal', () => {
        for (const n of normals) {
            const len = Math.hypot(n[0], n[1], n[2]);
            const e = decalEuler(n[0], n[1], n[2], 0.7);
            const r = applyEulerXYZ(e, 0, 0, 1);
            expect(r[0]).toBeCloseTo(n[0] / len, 5);
            expect(r[1]).toBeCloseTo(n[1] / len, 5);
            expect(r[2]).toBeCloseTo(n[2] / len, 5);
        }
    });

    test('normalizes the input normal', () => {
        const e = decalEuler(0, 5, 0);
        const r = applyEulerXYZ(e, 0, 0, 1);
        expect(r[0]).toBeCloseTo(0, 6);
        expect(r[1]).toBeCloseTo(1, 6);
        expect(r[2]).toBeCloseTo(0, 6);
    });

    test('produces finite values for a zero normal', () => {
        const e = decalEuler(0, 0, 0);
        expect(e.every((v) => Number.isFinite(v))).toBe(true);
    });
});

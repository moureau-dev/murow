import { describe, expect, test } from 'bun:test';
import { decalEuler, applyEulerXYZ } from './orientation';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('decal orientation', () => {
    test('identity euler keeps +Z', () => {
        const v = applyEulerXYZ([0, 0, 0], 0, 0, 1);
        expect(close(v[0], 0)).toBe(true);
        expect(close(v[1], 0)).toBe(true);
        expect(close(v[2], 1)).toBe(true);
    });

    test('euler points +Z along the given normal', () => {
        for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.6, -0.8, 0.2]] as const) {
            const e = decalEuler(n[0], n[1], n[2]);
            const v = applyEulerXYZ(e, 0, 0, 1);
            const len = Math.hypot(n[0], n[1], n[2]);
            expect(close(v[0], n[0] / len)).toBe(true);
            expect(close(v[1], n[1] / len)).toBe(true);
            expect(close(v[2], n[2] / len)).toBe(true);
        }
    });
});

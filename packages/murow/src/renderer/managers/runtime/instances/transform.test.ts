import { describe, expect, test } from 'bun:test';
import { resolveTransform } from './transform';

describe('resolveTransform', () => {
    test('applies defaults', () => {
        const t = resolveTransform({} as never);
        expect(t).toEqual({ px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, cr: 1, cg: 1, cb: 1 });
    });

    test('accepts a uniform number scale', () => {
        const t = resolveTransform({ scale: 2 } as never);
        expect([t.sx, t.sy, t.sz]).toEqual([2, 2, 2]);
    });

    test('passes through tuples', () => {
        const t = resolveTransform({ position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [4, 5, 6], color: [0.1, 0.2, 0.3] } as never);
        expect([t.px, t.py, t.pz]).toEqual([1, 2, 3]);
        expect([t.rx, t.ry, t.rz]).toEqual([0.1, 0.2, 0.3]);
        expect([t.sx, t.sy, t.sz]).toEqual([4, 5, 6]);
        expect([t.cr, t.cg, t.cb]).toEqual([0.1, 0.2, 0.3]);
    });
});

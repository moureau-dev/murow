import { describe, expect, test } from 'bun:test';
import { arrayOf, dynamicArrayOf } from './array';
import { f32, vec3f } from './primitives';

function view(size: number): DataView {
    return new DataView(new ArrayBuffer(size));
}

describe('arrayOf', () => {
    test('scalar array uses element stride', () => {
        const field = arrayOf(f32, 4);
        expect(field.size).toBe(16);
        expect(field.align).toBe(4);
        expect(field.type).toEqual({ kind: 'array', element: f32.type, count: 4 });
    });

    test('vec3 array stride is padded to its 16-byte alignment', () => {
        const field = arrayOf(vec3f, 2);
        expect(field.size).toBe(32);
        expect(field.align).toBe(16);
    });

    test('round-trips fixed arrays', () => {
        const field = arrayOf(f32, 3);
        const dv = view(field.size);
        field.write(dv, 0, [1, 2, 3]);
        expect(field.read(dv, 0)).toEqual([1, 2, 3]);
    });

    test('vec3 array round-trips with padding', () => {
        const field = arrayOf(vec3f, 2);
        const dv = view(field.size);
        field.write(dv, 0, [
            [1, 2, 3],
            [4, 5, 6],
        ]);
        expect(field.read(dv, 0)).toEqual([
            [1, 2, 3],
            [4, 5, 6],
        ]);
    });

    test('nil value has one entry per element', () => {
        expect(arrayOf(f32, 3).toNil()).toEqual([0, 0, 0]);
    });
});

describe('dynamicArrayOf', () => {
    test('is runtime-sized with an element stride', () => {
        const field = dynamicArrayOf(f32);
        expect(field.size).toBe(4);
        expect(field.align).toBe(4);
        expect(field.type).toEqual({ kind: 'array', element: f32.type, count: null });
    });

    test('writes from the host value length', () => {
        const field = dynamicArrayOf(f32);
        const dv = view(12);
        field.write(dv, 0, [7, 8, 9]);
        expect(dv.getFloat32(0, true)).toBe(7);
        expect(dv.getFloat32(8, true)).toBe(9);
        expect(field.read(dv, 0)).toEqual([]);
    });
});

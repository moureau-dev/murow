import { describe, expect, test } from 'bun:test';
import {
    bool,
    f32,
    i32,
    mat2x2f,
    mat3x3f,
    mat4x4f,
    u32,
    vec2f,
    vec3f,
    vec4f,
} from './primitives';

function view(size: number): DataView {
    return new DataView(new ArrayBuffer(size));
}

describe('scalar primitives', () => {
    test('f32 has std140 size, align, and type', () => {
        expect(f32.size).toBe(4);
        expect(f32.align).toBe(4);
        expect(f32.type).toEqual({ kind: 'scalar', scalar: 'f32' });
    });

    test('f32 round-trips little-endian bytes', () => {
        const dv = view(4);
        f32.write(dv, 0, 1.5);
        expect(dv.getFloat32(0, true)).toBe(1.5);
        expect(f32.read(dv, 0)).toBe(1.5);
    });

    test('i32 and u32 round-trip', () => {
        const dv = view(8);
        i32.write(dv, 0, -7);
        u32.write(dv, 4, 7);
        expect(i32.read(dv, 0)).toBe(-7);
        expect(u32.read(dv, 4)).toBe(7);
    });

    test('bool is 4 bytes and round-trips', () => {
        const dv = view(4);
        expect(bool.size).toBe(4);
        expect(bool.align).toBe(4);
        bool.write(dv, 0, true);
        expect(bool.read(dv, 0)).toBe(true);
        expect(bool.toNil()).toBe(false);
    });

    test('nil values are zero', () => {
        expect(f32.toNil()).toBe(0);
        expect(i32.toNil()).toBe(0);
        expect(u32.toNil()).toBe(0);
    });
});

describe('vector primitives', () => {
    test('vec3f is 12 bytes but aligns to 16', () => {
        expect(vec3f.size).toBe(12);
        expect(vec3f.align).toBe(16);
        expect(vec3f.type).toEqual({ kind: 'vec', scalar: 'f32', width: 3 });
    });

    test('vec2f and vec4f alignment', () => {
        expect(vec2f.size).toBe(8);
        expect(vec2f.align).toBe(8);
        expect(vec4f.size).toBe(16);
        expect(vec4f.align).toBe(16);
    });

    test('vectors round-trip', () => {
        const dv = view(16);
        vec3f.write(dv, 0, [1, 2, 3]);
        expect(vec3f.read(dv, 0)).toEqual([1, 2, 3]);
        vec4f.write(dv, 0, [4, 5, 6, 7]);
        expect(vec4f.read(dv, 0)).toEqual([4, 5, 6, 7]);
    });

    test('vector nil values', () => {
        expect(vec2f.toNil()).toEqual([0, 0]);
        expect(vec3f.toNil()).toEqual([0, 0, 0]);
        expect(vec4f.toNil()).toEqual([0, 0, 0, 0]);
    });
});

describe('matrix primitives', () => {
    test('mat4x4f is 64 bytes aligned to 16', () => {
        expect(mat4x4f.size).toBe(64);
        expect(mat4x4f.align).toBe(16);
        expect(mat4x4f.type).toEqual({ kind: 'mat', scalar: 'f32', cols: 4, rows: 4 });
    });

    test('mat3x3f is 48 bytes aligned to 16', () => {
        expect(mat3x3f.size).toBe(48);
        expect(mat3x3f.align).toBe(16);
    });

    test('mat2x2f is 16 bytes aligned to 8', () => {
        expect(mat2x2f.size).toBe(16);
        expect(mat2x2f.align).toBe(8);
    });

    test('mat4x4f round-trips', () => {
        const dv = view(64);
        const value = new Float32Array(16);
        for (let i = 0; i < 16; i++) value[i] = i + 0.5;
        mat4x4f.write(dv, 0, value);
        expect(Array.from(mat4x4f.read(dv, 0))).toEqual(Array.from(value));
    });
});

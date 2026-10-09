/**
 * GPU scalar, vector, and matrix field primitives.
 *
 * Every field is little-endian (GPU buffers are host order) and follows std140
 * alignment: scalars align to 4, `vec2` to 8, `vec3` and `vec4` to 16, and
 * matrices to the alignment of their column vector. A `vec3` is 12 bytes but
 * aligns to 16. Host values are numbers for scalars, tuples for vectors, and a
 * `Float32Array` of 16 for a `mat4x4f`.
 */
import type { Field } from './field';
import type { GpuType, MatType, ScalarType, VecType } from '../types';

/** A two component f32 vector. */
export type Vec2 = [number, number];
/** A three component f32 vector. */
export type Vec3 = [number, number, number];
/** A four component f32 vector. */
export type Vec4 = [number, number, number, number];
/** A 2x2 f32 matrix, column major. */
export type Mat2 = Float32Array;
/** A 3x3 f32 matrix, column major. */
export type Mat3 = Float32Array;
/** A 4x4 f32 matrix, column major. */
export type Mat4 = Float32Array;

function scalar(scalar: ScalarType['scalar']): ScalarType {
    return { kind: 'scalar', scalar };
}

function vec(width: VecType['width']): VecType {
    return { kind: 'vec', scalar: 'f32', width };
}

function mat(cols: MatType['cols'], rows: MatType['rows']): MatType {
    return { kind: 'mat', scalar: 'f32', cols, rows };
}

function readMat(dv: DataView, offset: number, count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getFloat32(offset + i * 4, true);
    return out;
}

function writeMat(dv: DataView, offset: number, value: ArrayLike<number>, count: number): void {
    for (let i = 0; i < count; i++) dv.setFloat32(offset + i * 4, value[i], true);
}

/** 32-bit float scalar. */
export const f32: Field<number, Float32Array> = {
    size: 4,
    align: 4,
    type: scalar('f32'),
    write: (dv, o, v) => dv.setFloat32(o, v, true),
    read: (dv, o) => dv.getFloat32(o, true),
    toNil: () => 0,
};

/** 32-bit signed integer scalar. */
export const i32: Field<number, Int32Array> = {
    size: 4,
    align: 4,
    type: scalar('i32'),
    write: (dv, o, v) => dv.setInt32(o, v, true),
    read: (dv, o) => dv.getInt32(o, true),
    toNil: () => 0,
};

/** 32-bit unsigned integer scalar. */
export const u32: Field<number, Uint32Array> = {
    size: 4,
    align: 4,
    type: scalar('u32'),
    write: (dv, o, v) => dv.setUint32(o, v, true),
    read: (dv, o) => dv.getUint32(o, true),
    toNil: () => 0,
};

/** Boolean scalar, stored as a 4-byte unsigned integer. */
export const bool: Field<boolean, Uint32Array> = {
    size: 4,
    align: 4,
    type: scalar('bool'),
    write: (dv, o, v) => dv.setUint32(o, v ? 1 : 0, true),
    read: (dv, o) => dv.getUint32(o, true) !== 0,
    toNil: () => false,
};

/** Two component f32 vector. */
export const vec2f: Field<Vec2, Float32Array> = {
    size: 8,
    align: 8,
    type: vec(2),
    write: (dv, o, v) => {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
    },
    read: (dv, o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true)],
    toNil: () => [0, 0],
};

/** Three component f32 vector. 12 bytes, 16-byte aligned. */
export const vec3f: Field<Vec3, Float32Array> = {
    size: 12,
    align: 16,
    type: vec(3),
    write: (dv, o, v) => {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
    },
    read: (dv, o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
    toNil: () => [0, 0, 0],
};

/** Four component f32 vector. */
export const vec4f: Field<Vec4, Float32Array> = {
    size: 16,
    align: 16,
    type: vec(4),
    write: (dv, o, v) => {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
        dv.setFloat32(o + 12, v[3], true);
    },
    read: (dv, o) => [
        dv.getFloat32(o, true),
        dv.getFloat32(o + 4, true),
        dv.getFloat32(o + 8, true),
        dv.getFloat32(o + 12, true),
    ],
    toNil: () => [0, 0, 0, 0],
};

/** 2x2 f32 matrix, column major. 16 bytes, 8-byte aligned. */
export const mat2x2f: Field<Mat2, Float32Array> = {
    size: 16,
    align: 8,
    type: mat(2, 2),
    write: (dv, o, v) => writeMat(dv, o, v, 4),
    read: (dv, o) => readMat(dv, o, 4),
    toNil: () => new Float32Array(4),
};

/** 3x3 f32 matrix, column major. 48 bytes, 16-byte aligned. */
export const mat3x3f: Field<Mat3, Float32Array> = {
    size: 48,
    align: 16,
    type: mat(3, 3),
    write: (dv, o, v) => writeMat(dv, o, v, 9),
    read: (dv, o) => readMat(dv, o, 9),
    toNil: () => new Float32Array(9),
};

/** 4x4 f32 matrix, column major. 64 bytes, 16-byte aligned. */
export const mat4x4f: Field<Mat4, Float32Array> = {
    size: 64,
    align: 16,
    type: mat(4, 4),
    write: (dv, o, v) => writeMat(dv, o, v, 16),
    read: (dv, o) => readMat(dv, o, 16),
    toNil: () => new Float32Array(16),
};

/** All primitive fields keyed by export name. */
export const primitives = {
    f32,
    i32,
    u32,
    bool,
    vec2f,
    vec3f,
    vec4f,
    mat2x2f,
    mat3x3f,
    mat4x4f,
} as const;

/** Re-export of the shared GPU type vocabulary for field kinds. */
export type { GpuType };

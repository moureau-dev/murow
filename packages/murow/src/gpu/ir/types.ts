/**
 * GPU value types for the IR.
 *
 * Re-exports the shared type vocabulary from `../types` and adds small
 * constructors and helpers used when building IR nodes.
 *
 * Pure data. No backend, no device.
 */
import type {
    ArrayType,
    GpuScalar,
    GpuType,
    MatType,
    SamplerType,
    ScalarType,
    StructFieldType,
    StructType,
    TextureAccess,
    TextureDim,
    TextureType,
    VecType,
} from '../types';

export type {
    ArrayType,
    GpuScalar,
    GpuType,
    MatType,
    SamplerType,
    ScalarType,
    StructFieldType,
    StructType,
    TextureAccess,
    TextureDim,
    TextureType,
    VecType,
} from '../types';

export { isHostShareable } from '../types';

/** Scalar type. */
export function scalar(base: GpuScalar): ScalarType {
    return { kind: 'scalar', scalar: base };
}

/** Vector type of the given width. */
export function vec(base: GpuScalar, width: 2 | 3 | 4): VecType {
    return { kind: 'vec', scalar: base, width };
}

/** Matrix type. */
export function mat(base: GpuScalar, cols: 2 | 3 | 4, rows: 2 | 3 | 4): MatType {
    return { kind: 'mat', scalar: base, cols, rows };
}

/** Fixed-size array (`null` count means runtime-sized). */
export function array(element: GpuType, count: number | null = null): ArrayType {
    return { kind: 'array', element, count };
}

/** A named struct field. */
export function field(name: string, type: GpuType): StructFieldType {
    return { name, type };
}

/** Named struct type. */
export function struct(name: string, fields: readonly StructFieldType[]): StructType {
    return { kind: 'struct', name, fields };
}

/** Texture type. */
export function texture(
    base: GpuScalar,
    dim: TextureDim,
    access: TextureAccess,
    opts: { depth?: boolean; format?: string; sampleType?: string } = {},
): TextureType {
    return {
        kind: 'texture',
        scalar: base,
        dim,
        access,
        ...(opts.depth ? { depth: true } : {}),
        ...(opts.format ? { format: opts.format } : {}),
        ...(opts.sampleType ? { sampleType: opts.sampleType } : {}),
    };
}

/** Sampler type. */
export function sampler(comparison = false): SamplerType {
    return { kind: 'sampler', comparison };
}

/** `f32` scalar. */
export function f32(): ScalarType {
    return scalar('f32');
}

/** `i32` scalar. */
export function i32(): ScalarType {
    return scalar('i32');
}

/** `u32` scalar. */
export function u32(): ScalarType {
    return scalar('u32');
}

/** `bool` scalar. */
export function bool(): ScalarType {
    return scalar('bool');
}

/**
 * Result type of a swizzle. A single component yields the scalar type, otherwise
 * a vector of the mask width. Non-vector input is returned unchanged.
 */
export function swizzleType(type: GpuType, mask: string): GpuType {
    if (type.kind !== 'vec') return type;
    if (mask.length === 1) return { kind: 'scalar', scalar: type.scalar };
    return { kind: 'vec', scalar: type.scalar, width: Math.min(mask.length, 4) as 2 | 3 | 4 };
}

/** Structural equality of two GPU types. Structs compare by name and fields. */
export function typeEquals(a: GpuType, b: GpuType): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
        case 'scalar':
            return a.scalar === (b as ScalarType).scalar;
        case 'vec': {
            const v = b as VecType;
            return a.scalar === v.scalar && a.width === v.width;
        }
        case 'mat': {
            const m = b as MatType;
            return a.scalar === m.scalar && a.cols === m.cols && a.rows === m.rows;
        }
        case 'array': {
            const ar = b as ArrayType;
            return a.count === ar.count && typeEquals(a.element, ar.element);
        }
        case 'struct': {
            const s = b as StructType;
            if (a.name !== s.name || a.fields.length !== s.fields.length) return false;
            for (let i = 0; i < a.fields.length; i++) {
                if (a.fields[i]!.name !== s.fields[i]!.name) return false;
                if (!typeEquals(a.fields[i]!.type, s.fields[i]!.type)) return false;
            }
            return true;
        }
        case 'texture': {
            const t = b as TextureType;
            return a.scalar === t.scalar && a.dim === t.dim && a.access === t.access
                && (a.depth ?? false) === (t.depth ?? false) && a.format === t.format;
        }
        case 'sampler':
            return a.comparison === (b as SamplerType).comparison;
    }
}

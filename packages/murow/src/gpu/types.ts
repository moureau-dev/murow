/**
 * Shared GPU type vocabulary.
 *
 * These descriptors describe GPU values (scalars, vectors, matrices, arrays,
 * structs, textures, samplers) independently of the backend. Memory schemas
 * (`schema/`) and the intermediate representation (`ir/`) both speak this
 * vocabulary, so a struct field and an IR value agree on the same type.
 *
 * Pure data. No backend, no device, no allocations in hot paths.
 */

export type GpuScalar = 'f32' | 'i32' | 'u32' | 'bool';

export interface ScalarType {
    readonly kind: 'scalar';
    readonly scalar: GpuScalar;
}

export interface VecType {
    readonly kind: 'vec';
    readonly scalar: GpuScalar;
    readonly width: 2 | 3 | 4;
}

export interface MatType {
    readonly kind: 'mat';
    readonly scalar: GpuScalar;
    readonly cols: 2 | 3 | 4;
    readonly rows: 2 | 3 | 4;
}

export interface ArrayType {
    readonly kind: 'array';
    readonly element: GpuType;
    /** `null` means runtime-sized (storage buffer tail). */
    readonly count: number | null;
}

export interface StructFieldType {
    readonly name: string;
    readonly type: GpuType;
}

export interface StructType {
    readonly kind: 'struct';
    /** Struct name, used when emitting target source. */
    readonly name: string;
    readonly fields: readonly StructFieldType[];
}

export type TextureDim = '1d' | '2d' | '3d' | 'cube' | '2d-array' | 'cube-array';
export type TextureAccess = 'sample' | 'read' | 'write' | 'read-write';

export interface TextureType {
    readonly kind: 'texture';
    readonly scalar: GpuScalar;
    readonly dim: TextureDim;
    readonly access: TextureAccess;
    /** Depth texture, used by shadow maps. */
    readonly depth?: boolean;
    /** Storage-texture format, for example `rgba16float`. Storage textures only. */
    readonly format?: string;
    /** Sample type of a sampled texture, for example `unfilterable-float`. */
    readonly sampleType?: string;
}

export interface SamplerType {
    readonly kind: 'sampler';
    readonly comparison: boolean;
}

export type GpuType =
    | ScalarType
    | VecType
    | MatType
    | ArrayType
    | StructType
    | TextureType
    | SamplerType;

/** Whether a type can be used as a vertex/fragment varying or uniform member. */
export function isHostShareable(type: GpuType): boolean {
    return type.kind !== 'texture' && type.kind !== 'sampler';
}

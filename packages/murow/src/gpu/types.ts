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
    /** Struct name, used when emitting WGSL/GLSL. */
    readonly name: string;
    readonly fields: readonly StructFieldType[];
}

export type TextureDim = '1d' | '2d' | '3d' | 'cube' | '2d-array';
export type TextureAccess = 'sample' | 'read' | 'write' | 'read-write';

export interface TextureType {
    readonly kind: 'texture';
    readonly scalar: GpuScalar;
    readonly dim: TextureDim;
    readonly access: TextureAccess;
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

/** WGSL spelling of a type. Structs emit by name. */
export function wgslType(type: GpuType): string {
    switch (type.kind) {
        case 'scalar':
            return wgslScalar(type.scalar);
        case 'vec':
            return `vec${type.width}<${wgslScalar(type.scalar)}>`;
        case 'mat':
            return `mat${type.cols}x${type.rows}<${wgslScalar(type.scalar)}>`;
        case 'array': {
            const element = wgslType(type.element);
            return type.count === null ? `array<${element}>` : `array<${element}, ${type.count}>`;
        }
        case 'struct':
            return type.name;
        case 'texture':
            return `texture_${type.dim.replace('-', '_')}<${wgslScalar(type.scalar)}>`;
        case 'sampler':
            return type.comparison ? 'sampler_comparison' : 'sampler';
    }
}

/** GLSL spelling of a type. Structs emit by name. */
export function glslType(type: GpuType): string {
    switch (type.kind) {
        case 'scalar':
            return glslScalar(type.scalar);
        case 'vec':
            return glslVec(scalarBase(type.scalar), type.width);
        case 'mat':
            return glslMat(scalarBase(type.scalar), type.cols, type.cols);
        case 'array':
            return type.count === null ? `${glslType(type.element)}[]` : `${glslType(type.element)}[${type.count}]`;
        case 'struct':
            return type.name;
        case 'texture':
            return glslSampler(type);
        case 'sampler':
            return type.comparison ? 'sampler2DShadow' : 'sampler2D';
    }
}

function scalarBase(scalar: GpuScalar): string {
    return scalar === 'f32' || scalar === 'i32' || scalar === 'u32' ? scalar : 'f32';
}

function wgslScalar(scalar: GpuScalar): string {
    return scalar;
}

function glslScalar(scalar: GpuScalar): string {
    if (scalar === 'f32') return 'float';
    if (scalar === 'i32') return 'int';
    if (scalar === 'u32') return 'uint';
    return 'bool';
}

function glslVec(base: string, width: number): string {
    const prefix = base === 'f32' ? 'vec' : base === 'i32' ? 'ivec' : 'uvec';
    return `${prefix}${width}`;
}

function glslMat(base: string, cols: number, rows: number): string {
    if (base === 'f32') return `mat${cols}`;
    return `mat${cols}x${rows}`;
}

function glslSampler(type: TextureType): string {
    const prefix = type.scalar === 'i32' ? 'isampler' : type.scalar === 'u32' ? 'usampler' : 'sampler';
    const suffix = type.dim === 'cube' ? 'Cube' : type.dim === '3d' ? '3D' : type.dim === '2d-array' ? '2DArray' : '2D';
    return `${prefix}${suffix}`;
}

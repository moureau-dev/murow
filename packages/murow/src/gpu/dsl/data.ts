/**
 * The unified `d` namespace: value constructors, schema type descriptors, and
 * builtin markers.
 *
 * Each member is both a type descriptor usable in struct fields and IR
 * signatures, and a callable that builds an IR value. `d.struct({...})` returns
 * a `GpuStruct` from `murow/gpu/schema`, so it can be passed straight to a
 * context's `createBuffer`.
 *
 * Pure. No backend, no device.
 */
import {
    GpuStruct,
    gpuStruct,
    Std430,
    bool as boolField,
    f32 as f32Field,
    i32 as i32Field,
    u32 as u32Field,
    vec2f as vec2fField,
    vec3f as vec3fField,
    vec4f as vec4fField,
    mat2x2f as mat2x2fField,
    mat3x3f as mat3x3fField,
    mat4x4f as mat4x4fField,
} from '../schema';
import type { Field } from '../schema/field';
import {
    array as arrayType,
    bool as boolType,
    f32 as f32Type,
    i32 as i32Type,
    mat as matType,
    texture as textureType,
    u32 as u32Type,
    vec as vecType,
    type ArrayType,
    type GpuScalar,
    type GpuType,
    type StructType,
} from '../ir/types';
import { cast, construct, literal } from '../ir/builders';
import { ShaderValue, toExpr, type ShaderInput } from './value';

/** Marker for a stage builtin such as `position` or `instance_index`. */
export interface BuiltinMarker {
    readonly __builtin: string;
    readonly type: GpuType;
}

/** Marker for a vertex input location. */
export interface LocationMarker {
    readonly __location: number;
    readonly type: GpuType;
}

/** Align `offset` up to `alignment`. */
export function alignUp(offset: number, alignment: number): number {
    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

/** The GPU type behind a schema value, a struct, or a bare type descriptor. */
export function typeOf(value: any): GpuType {
    if (value instanceof GpuStruct) return value.type;
    if (value && typeof value.kind === 'string') return value as GpuType;
    if (value && value.type && typeof value.type.kind === 'string') return value.type as GpuType;
    return value as GpuType;
}

/** Byte size of a bare GPU type descriptor. */
export function typeSize(type: GpuType): number {
    switch (type.kind) {
        case 'scalar':
            return 4;
        case 'vec':
            return type.width * 4;
        case 'mat':
            return type.cols * type.rows * 4;
        case 'array': {
            const stride = alignUp(typeSize(type.element), typeAlign(type.element));
            return type.count === null ? stride : stride * type.count;
        }
        case 'struct': {
            let offset = 0;
            let memberAlign = 1;
            for (const field of type.fields) {
                const fieldAlign = typeAlign(field.type);
                offset = alignUp(offset, fieldAlign);
                offset += typeSize(field.type);
                if (fieldAlign > memberAlign) memberAlign = fieldAlign;
            }
            return alignUp(offset, alignUp(memberAlign, 16));
        }
        default:
            return 0;
    }
}

/** Alignment of a bare GPU type descriptor. */
export function typeAlign(type: GpuType): number {
    switch (type.kind) {
        case 'scalar':
            return 4;
        case 'vec':
            return type.width === 2 ? 8 : 16;
        case 'mat':
            return type.cols === 2 && type.rows === 2 ? 8 : 16;
        case 'array':
            return typeAlign(type.element);
        case 'struct': {
            let memberAlign = 1;
            for (const field of type.fields) {
                const fieldAlign = typeAlign(field.type);
                if (fieldAlign > memberAlign) memberAlign = fieldAlign;
            }
            return alignUp(memberAlign, 16);
        }
        default:
            return 1;
    }
}

/** Alignment of a schema value, a struct, or a bare type descriptor. */
export function alignOf(value: any): number {
    if (value instanceof GpuStruct) return value.align;
    if (typeof value?.align === 'number') return value.align;
    return typeAlign(typeOf(value));
}

/** Byte size of a schema value, a struct, or a bare type descriptor. */
export function sizeOf(value: any): number {
    if (value instanceof GpuStruct) return value.size;
    if (typeof value?.size === 'number') return value.size;
    return typeSize(typeOf(value));
}

function value(node: ReturnType<typeof literal> | ReturnType<typeof construct> | ReturnType<typeof cast>): ShaderValue {
    return new ShaderValue({ node });
}

function scalarType(scalar: GpuScalar): GpuType {
    return { kind: 'scalar', scalar };
}

/** Build a scalar constructor that also carries its schema field. */
function makeScalar(name: GpuScalar, field: Field<any, any>): any {
    const type = scalarType(name);
    const constructValue = (v: ShaderInput): ShaderValue =>
        typeof v === 'number' ? value(literal(type, v)) : value(cast(type, toExpr(v)));
    return Object.assign(constructValue, field, { kind: 'scalar', scalar: name, type });
}

/** Build a float vector constructor that also carries its schema field. */
function makeVec(name: string, width: 2 | 3 | 4, field: Field<any, any>): any {
    const type = vecType('f32', width);
    const constructValue = (...args: readonly ShaderInput[]): ShaderValue =>
        value(construct(type, args.map(toExpr)));
    return Object.assign(constructValue, field, { kind: 'vec', scalar: 'f32', width, type });
}

/** Build a float matrix constructor that also carries its schema field. */
function makeMat(name: string, cols: 2 | 3 | 4, rows: 2 | 3 | 4, field: Field<any, any>): any {
    const type = matType('f32', cols, rows);
    const constructValue = (...args: readonly ShaderInput[]): ShaderValue =>
        value(construct(type, args.map(toExpr)));
    return Object.assign(constructValue, field, { kind: 'mat', scalar: 'f32', cols, rows, type });
}

/** Build an unsigned integer vector constructor. */
function makeU32Vec(width: 2 | 3 | 4, field: Field<any, any>): any {
    const type = vecType('u32', width);
    const constructValue = (...args: readonly ShaderInput[]): ShaderValue =>
        value(construct(type, args.map(toExpr)));
    return Object.assign(constructValue, field, { kind: 'vec', scalar: 'u32', width, type });
}

const u32Vec3 = makeU32Vec(3, vec3fField);

let structCount = 0;

/** A struct exposed as a schema field, so it can nest. */
function structAsField(struct: GpuStruct): any {
    return {
        size: struct.size,
        align: struct.align,
        type: struct.type,
        write(dv: DataView, offset: number, value_: any): void {
            if (value_ === null || value_ === undefined) return;
            for (const member of struct.fields) {
                member.field.write(dv, offset + member.offset, value_[member.name]);
            }
        },
        read(dv: DataView, offset: number): Record<string, any> {
            const out: Record<string, any> = {};
            for (const member of struct.fields) {
                out[member.name] = member.field.read(dv, offset + member.offset);
            }
            return out;
        },
        toNil(): Record<string, any> {
            const out: Record<string, any> = {};
            for (const member of struct.fields) out[member.name] = member.field.toNil();
            return out;
        },
    };
}

function elementNil(element: any): any {
    if (element && typeof element.toNil === 'function') return element.toNil();
    if (element instanceof GpuStruct) {
        const out: Record<string, any> = {};
        for (const member of element.fields) out[member.name] = member.field.toNil();
        return out;
    }
    return 0;
}

function writeElement(element: any, dv: DataView, offset: number, value_: any): void {
    if (typeof element.write === 'function') {
        element.write(dv, offset, value_);
        return;
    }
    if (element instanceof GpuStruct) {
        for (const member of element.fields) {
            member.field.write(dv, offset + member.offset, value_?.[member.name]);
        }
    }
}

function readElement(element: any, dv: DataView, offset: number): any {
    if (typeof element.read === 'function') return element.read(dv, offset);
    if (element instanceof GpuStruct) {
        const out: Record<string, any> = {};
        for (const member of element.fields) {
            out[member.name] = member.field.read(dv, offset + member.offset);
        }
        return out;
    }
    return undefined;
}

const builtins: Record<string, BuiltinMarker> = {
    position: { __builtin: 'position', type: makeVec('vec4f', 4, vec4fField) },
    vertex_index: { __builtin: 'vertex_index', type: makeScalar('u32', u32Field) },
    vertexIndex: { __builtin: 'vertex_index', type: makeScalar('u32', u32Field) },
    instance_index: { __builtin: 'instance_index', type: makeScalar('u32', u32Field) },
    instanceIndex: { __builtin: 'instance_index', type: makeScalar('u32', u32Field) },
    front_facing: { __builtin: 'front_facing', type: makeScalar('bool', boolField) },
    frontFacing: { __builtin: 'front_facing', type: makeScalar('bool', boolField) },
    frag_coord: { __builtin: 'position', type: makeVec('vec4f', 4, vec4fField) },
    fragCoord: { __builtin: 'position', type: makeVec('vec4f', 4, vec4fField) },
    invocation_id: { __builtin: 'global_invocation_id', type: u32Vec3 },
    invocationId: { __builtin: 'global_invocation_id', type: u32Vec3 },
    globalInvocationId: { __builtin: 'global_invocation_id', type: u32Vec3 },
    local_invocation_id: { __builtin: 'local_invocation_id', type: u32Vec3 },
    localInvocationId: { __builtin: 'local_invocation_id', type: u32Vec3 },
    global_invocation_id: { __builtin: 'global_invocation_id', type: u32Vec3 },
    local_invocation_index: { __builtin: 'local_invocation_index', type: makeScalar('u32', u32Field) },
    localInvocationIndex: { __builtin: 'local_invocation_index', type: makeScalar('u32', u32Field) },
    localId: { __builtin: 'local_invocation_id', type: u32Vec3 },
    globalId: { __builtin: 'global_invocation_id', type: u32Vec3 },
    workgroup_id: { __builtin: 'workgroup_id', type: u32Vec3 },
    workgroupId: { __builtin: 'workgroup_id', type: u32Vec3 },
    num_workgroups: { __builtin: 'num_workgroups', type: u32Vec3 },
    numWorkgroups: { __builtin: 'num_workgroups', type: u32Vec3 },
};

/** The unified data/value namespace. */
export const d = {
    f32: makeScalar('f32', f32Field),
    i32: makeScalar('i32', i32Field),
    u32: makeScalar('u32', u32Field),
    bool: makeScalar('bool', boolField),

    vec2f: makeVec('vec2f', 2, vec2fField),
    vec3f: makeVec('vec3f', 3, vec3fField),
    vec4f: makeVec('vec4f', 4, vec4fField),
    vec4u: makeU32Vec(4, vec4fField),
    mat2x2f: makeMat('mat2x2f', 2, 2, mat2x2fField),
    mat3x3f: makeMat('mat3x3f', 3, 3, mat3x3fField),
    mat4x4f: makeMat('mat4x4f', 4, 4, mat4x4fField),

    /** Alias for `vec3f`. */
    v3f: null as any,
    /** Alias for `vec4f`. */
    v4f: null as any,
    /** Alias for `vec2f`. */
    v2f: null as any,
    /** Alias for `mat3x3f`. */
    m3x3f: null as any,
    /** Alias for `mat4x4f`. */
    m4x4f: null as any,

    /** Build an array value from a type and its element values. */
    array(element: any, values: readonly ShaderInput[]): ShaderValue {
        const type = arrayType(typeOf(element), values.length);
        return value(construct(type, values.map(toExpr)));
    },

    /** A sampled 2D texture type, used in a bind group layout descriptor. */
    texture2d(): any {
        return { type: textureType('f32', '2d', 'sample'), sampleType: 'float', viewDimension: '2d' };
    },

    /** Mark an integer type as an atomic, for storage-buffer atomics. */
    atomic(inner: any): any {
        const base = typeOf(inner);
        const out: any = { ...base, atomic: true };
        out.type = out;
        return out;
    },

    /**
     * Build a `GpuStruct` from a record of fields. A nested `GpuStruct` is
     * exposed as a field, so structs can compose.
     */
    struct(fields: Record<string, Field<any, any> | GpuStruct>): GpuStruct {
        const normalized: Record<string, Field<any, any>> = {};
        for (const key of Object.keys(fields)) {
            const member = fields[key]!;
            normalized[key] = member instanceof GpuStruct
                ? (structAsField(member) as Field<any, any>)
                : member;
        }
        return gpuStruct({ name: `Struct${structCount++}`, fields: normalized, packing: Std430 });
    },

    /** Build a fixed-length array type descriptor. */
    arrayOf(element: any, count: number): any {
        const type = typeOf(element);
        const size = sizeOf(element);
        const align = alignOf(element);
        const stride = alignUp(size, align);
        const array: ArrayType = { kind: 'array', element: type, count };
        const constructValue = (...values: readonly ShaderInput[]): ShaderValue =>
            value(construct(array, values.map(toExpr)));
        return Object.assign(constructValue, {
            kind: 'array',
            element: type,
            count,
            size: stride * count,
            align,
            type: array,
            write(dv: DataView, offset: number, value_: any[]): void {
                for (let i = 0; i < count; i++) writeElement(element, dv, offset + i * stride, value_[i]);
            },
            read(dv: DataView, offset: number): any[] {
                const out: any[] = [];
                for (let i = 0; i < count; i++) out.push(readElement(element, dv, offset + i * stride));
                return out;
            },
            toNil(): any[] {
                const out: any[] = [];
                for (let i = 0; i < count; i++) out.push(elementNil(element));
                return out;
            },
        });
    },

    /** Byte size of a schema value, struct, or type descriptor. */
    sizeOf,

    /** Stage builtin markers. */
    builtin: builtins,

    /** Build a vertex input location marker. */
    location(index: number, type: any): LocationMarker {
        return { __location: index, type: typeOf(type) };
    },
};

d.v3f = d.vec3f;
d.v4f = d.vec4f;
d.v2f = d.vec2f;
d.m3x3f = d.mat3x3f;
d.m4x4f = d.mat4x4f;

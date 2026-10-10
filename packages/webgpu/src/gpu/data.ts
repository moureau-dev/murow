/**
 * A typegpu-compatible `d` data namespace backed by `murow/gpu`.
 *
 * Each member is both a type descriptor usable in struct fields and IR
 * signatures, and a callable that builds an IR value through `murow/gpu`'s
 * `d`. `d.struct` returns a `GpuStruct` from `murow/gpu/schema`, so it can be
 * passed straight to `root.createBuffer`.
 *
 * Pure. No device, no allocations in hot paths.
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
} from 'murow/gpu/schema';
import { d as gpuD, ShaderValue, toExpr } from 'murow/gpu/dsl';
import { construct as constructNode, texture as textureType, vec as vecType } from 'murow/gpu/ir';
import type { ArrayType, GpuScalar, GpuType, StructType } from 'murow/gpu/ir';

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
            const structAlign = alignUp(memberAlign, 16);
            return alignUp(offset, structAlign);
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

function makeScalar(name: GpuScalar, field: any): any {
    const construct = (value: any) => (gpuD as any)[name](value);
    return Object.assign(construct, field, { kind: 'scalar', scalar: name });
}

function makeVec(name: string, width: 2 | 3 | 4, field: any): any {
    const construct = (...args: any[]) => (gpuD as any)[name](...args);
    return Object.assign(construct, field, { kind: 'vec', scalar: 'f32', width });
}

function makeMat(name: string, cols: 2 | 3 | 4, rows: 2 | 3 | 4, field: any): any {
    const construct = (...args: any[]) => (gpuD as any)[name](...args);
    return Object.assign(construct, field, { kind: 'mat', scalar: 'f32', cols, rows });
}

function makeU32Vec(width: 2 | 3 | 4, field: any): any {
    const type = vecType('u32', width);
    const construct = (...args: any[]) =>
        new ShaderValue({ node: constructNode(type, args.map(toExpr)) });
    return Object.assign(construct, field, type, { type });
}

const u32Vec3 = makeU32Vec(3, vec3fField);

let structCount = 0;

function structAsField(struct: GpuStruct): any {
    return {
        size: struct.size,
        align: struct.align,
        type: struct.type,
        write(dv: DataView, offset: number, value: any): void {
            if (value === null || value === undefined) return;
            for (const member of struct.fields) {
                member.field.write(dv, offset + member.offset, value[member.name]);
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

/** The zero value for an array element, matching its field shape. */
function elementNil(element: any): any {
    if (element && typeof element.toNil === 'function') return element.toNil();
    if (element instanceof GpuStruct) {
        const out: Record<string, any> = {};
        for (const member of element.fields) out[member.name] = member.field.toNil();
        return out;
    }
    return 0;
}

function writeElement(element: any, dv: DataView, offset: number, value: any): void {
    if (typeof element.write === 'function') {
        element.write(dv, offset, value);
        return;
    }
    if (element instanceof GpuStruct) {
        for (const member of element.fields) {
            member.field.write(dv, offset + member.offset, value?.[member.name]);
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

/** The typegpu-compatible data namespace. */
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

    /** A sampled 2D texture type, used in a bind group layout descriptor. */
    texture2d(): any {
        return {
            type: textureType('f32', '2d', 'sample'),
            sampleType: 'float',
            viewDimension: '2d',
        };
    },

    /** Mark an integer type as an atomic, for storage-buffer atomics. */
    atomic(inner: any): any {
        const base = typeOf(inner);
        const out: any = { ...base, atomic: true };
        out.type = out;
        return out;
    },

    /** Build a `GpuStruct` from a record of fields. */
    struct(fields: Record<string, any>): GpuStruct {
        const normalized: Record<string, any> = {};
        for (const key of Object.keys(fields)) {
            const value = fields[key];
            normalized[key] = value instanceof GpuStruct ? structAsField(value) : value;
        }
        return gpuStruct({ name: `Struct${structCount++}`, fields: normalized, packing: Std430 });
    },

    /** Build a fixed-length array type descriptor. */
    arrayOf(element: any, count: number): any {
        const type = typeOf(element);
        const size = sizeOf(element);
        const align = alignOf(element);
        const stride = alignUp(size, align);
        const arrayType: ArrayType = { kind: 'array', element: type, count };
        const construct = (...values: any[]) => (gpuD as any).array(type, values);
        return Object.assign(construct, {
            kind: 'array',
            element: type,
            count,
            size: stride * count,
            align,
            type: arrayType,
            write(dv: DataView, offset: number, value: any[]): void {
                for (let i = 0; i < count; i++) writeElement(element, dv, offset + i * stride, value[i]);
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

export type StructDesc = StructType;

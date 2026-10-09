/**
 * Value constructors.
 *
 * `d` mirrors the WGSL constructor names (`f32`, `vec3f`, ...) and produces IR
 * `literal` and `construct` nodes wrapped in `ShaderValue`.
 *
 * Pure. No backend, no device.
 */
import type { GpuType, StructType } from '../types';
import type { IrExpr } from '../ir/nodes';
import { array as arrayType, bool as boolType, f32 as f32Type, i32 as i32Type, mat as matType, u32 as u32Type, vec as vecType } from '../ir/types';
import { cast, construct, literal } from '../ir/builders';
import { ShaderValue, toExpr, type ShaderInput } from './value';

function value(node: IrExpr): ShaderValue {
    return new ShaderValue({ node });
}

function constructValue(type: GpuType, args: readonly ShaderInput[]): ShaderValue {
    return value(construct(type, args.map(toExpr)));
}

/** Constructors that build IR values. Numbers build literals, values build casts. */
export const d = {
    f32(v: ShaderInput): ShaderValue {
        if (typeof v === 'number') return value(literal(f32Type(), v));
        return value(cast(f32Type(), toExpr(v)));
    },

    i32(v: ShaderInput): ShaderValue {
        if (typeof v === 'number') return value(literal(i32Type(), v));
        return value(cast(i32Type(), toExpr(v)));
    },

    u32(v: ShaderInput): ShaderValue {
        if (typeof v === 'number') return value(literal(u32Type(), v));
        return value(cast(u32Type(), toExpr(v)));
    },

    bool(v: ShaderInput): ShaderValue {
        if (typeof v === 'boolean') return value(literal(boolType(), v));
        return value(cast(boolType(), toExpr(v)));
    },

    vec2f(x: ShaderInput, y: ShaderInput): ShaderValue {
        return constructValue(vecType('f32', 2), [x, y]);
    },

    vec3f(x: ShaderInput, y: ShaderInput, z: ShaderInput): ShaderValue {
        return constructValue(vecType('f32', 3), [x, y, z]);
    },

    vec4f(x: ShaderInput, y: ShaderInput, z: ShaderInput, w: ShaderInput): ShaderValue {
        return constructValue(vecType('f32', 4), [x, y, z, w]);
    },

    mat2x2f(...values: readonly ShaderInput[]): ShaderValue {
        return constructValue(matType('f32', 2, 2), values);
    },

    mat3x3f(...values: readonly ShaderInput[]): ShaderValue {
        return constructValue(matType('f32', 3, 3), values);
    },

    mat4x4f(...values: readonly ShaderInput[]): ShaderValue {
        return constructValue(matType('f32', 4, 4), values);
    },

    array(element: GpuType, values: readonly ShaderInput[]): ShaderValue {
        return constructValue(arrayType(element, values.length), values);
    },

    struct(type: StructType, values: Record<string, ShaderInput>): ShaderValue {
        const args = type.fields.map((field) => {
            const fieldValue = values[field.name];
            if (fieldValue === undefined) throw new Error(`d.struct: missing field '${field.name}'`);
            return toExpr(fieldValue);
        });
        return value(construct(type, args));
    },
};

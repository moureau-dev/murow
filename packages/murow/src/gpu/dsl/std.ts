/**
 * Builtins.
 *
 * `std` is the shader math namespace used inside entry bodies. Each builtin
 * builds an IR `call` (or `sample`) node with a sensible result type. It also
 * spreads `d`, so constructors are reachable as `std.vec3f` and the like.
 *
 * Pure. No backend, no device.
 */
import type { GpuType } from '../types';
import type { IrExpr } from '../ir/nodes';
import { binary, call, discardStmt, exprStmt, sample, unary } from '../ir/builders';
import { bool as boolType, f32 as f32Type, u32 as u32Type, vec as vecType } from '../ir/types';
import { combineType, scalarOf, ShaderValue, toExpr, vecOf, type ShaderInput } from './value';
import { d } from './data';
import type { TypedStd } from './typed';

function value(node: IrExpr): ShaderValue {
    return new ShaderValue({ node });
}

function unaryCall(name: string, a: ShaderInput): ShaderValue {
    const ea = toExpr(a);
    return value(call(ea.type, name, [ea]));
}

function binaryCall(name: string, a: ShaderInput, b: ShaderInput): ShaderValue {
    const ea = toExpr(a);
    const eb = toExpr(b);
    return value(call(combineType(ea.type, eb.type), name, [ea, eb]));
}

function ternaryCall(name: string, a: ShaderInput, b: ShaderInput, c: ShaderInput, type: GpuType): ShaderValue {
    return value(call(type, name, [toExpr(a), toExpr(b), toExpr(c)]));
}

/** Shader builtins and value constructors. */
const stdImpl = {
    ...d,

    add(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('add', a, b);
    },

    sub(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('sub', a, b);
    },

    mul(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('mul', a, b);
    },

    div(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('div', a, b);
    },

    mod(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('mod', a, b);
    },

    neg(a: ShaderInput): ShaderValue {
        return unaryCall('neg', a);
    },

    lt(a: ShaderInput, b: ShaderInput): ShaderValue {
        return value(binary(boolType(), '<', toExpr(a), toExpr(b)));
    },

    lte(a: ShaderInput, b: ShaderInput): ShaderValue {
        return value(binary(boolType(), '<=', toExpr(a), toExpr(b)));
    },

    gt(a: ShaderInput, b: ShaderInput): ShaderValue {
        return value(binary(boolType(), '>', toExpr(a), toExpr(b)));
    },

    gte(a: ShaderInput, b: ShaderInput): ShaderValue {
        return value(binary(boolType(), '>=', toExpr(a), toExpr(b)));
    },

    eq(a: ShaderInput, b: ShaderInput): ShaderValue {
        return value(binary(boolType(), '==', toExpr(a), toExpr(b)));
    },

    dot(a: ShaderInput, b: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        const eb = toExpr(b);
        return value(call(scalarOf(combineType(ea.type, eb.type)), 'dot', [ea, eb]));
    },

    cross(a: ShaderInput, b: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        const eb = toExpr(b);
        return value(call(vecOf(combineType(ea.type, eb.type), 3), 'cross', [ea, eb]));
    },

    distance(a: ShaderInput, b: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        const eb = toExpr(b);
        return value(call(scalarOf(combineType(ea.type, eb.type)), 'distance', [ea, eb]));
    },

    reflect(a: ShaderInput, b: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        return value(call(ea.type, 'reflect', [ea, toExpr(b)]));
    },

    refract(a: ShaderInput, b: ShaderInput, eta: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        return value(call(ea.type, 'refract', [ea, toExpr(b), toExpr(eta)]));
    },

    faceForward(a: ShaderInput, b: ShaderInput, c: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        return value(call(ea.type, 'faceForward', [ea, toExpr(b), toExpr(c)]));
    },

    normalize(a: ShaderInput): ShaderValue {
        return unaryCall('normalize', a);
    },

    length(a: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        return value(call(scalarOf(ea.type), 'length', [ea]));
    },

    mix(a: ShaderInput, b: ShaderInput, t: ShaderInput): ShaderValue {
        return ternaryCall('mix', a, b, t, combineType(toExpr(a).type, toExpr(b).type));
    },

    clamp(a: ShaderInput, low: ShaderInput, high: ShaderInput): ShaderValue {
        return ternaryCall('clamp', a, low, high, toExpr(a).type);
    },

    saturate(a: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        return value(call(ea.type, 'saturate', [ea]));
    },

    step(edge: ShaderInput, x: ShaderInput): ShaderValue {
        return binaryCall('step', edge, x);
    },

    smoothstep(e0: ShaderInput, e1: ShaderInput, x: ShaderInput): ShaderValue {
        return ternaryCall('smoothstep', e0, e1, x, toExpr(x).type);
    },

    min(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('min', a, b);
    },

    max(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('max', a, b);
    },

    pow(a: ShaderInput, b: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        const eb = toExpr(b);
        return value(call(combineType(ea.type, eb.type), 'pow', [ea, eb]));
    },

    atan2(a: ShaderInput, b: ShaderInput): ShaderValue {
        return binaryCall('atan2', a, b);
    },

    sin(a: ShaderInput): ShaderValue {
        return unaryCall('sin', a);
    },

    cos(a: ShaderInput): ShaderValue {
        return unaryCall('cos', a);
    },

    tan(a: ShaderInput): ShaderValue {
        return unaryCall('tan', a);
    },

    asin(a: ShaderInput): ShaderValue {
        return unaryCall('asin', a);
    },

    acos(a: ShaderInput): ShaderValue {
        return unaryCall('acos', a);
    },

    atan(a: ShaderInput): ShaderValue {
        return unaryCall('atan', a);
    },

    exp(a: ShaderInput): ShaderValue {
        return unaryCall('exp', a);
    },

    exp2(a: ShaderInput): ShaderValue {
        return unaryCall('exp2', a);
    },

    log(a: ShaderInput): ShaderValue {
        return unaryCall('log', a);
    },

    log2(a: ShaderInput): ShaderValue {
        return unaryCall('log2', a);
    },

    sqrt(a: ShaderInput): ShaderValue {
        return unaryCall('sqrt', a);
    },

    inverseSqrt(a: ShaderInput): ShaderValue {
        return unaryCall('inverseSqrt', a);
    },

    sign(a: ShaderInput): ShaderValue {
        return unaryCall('sign', a);
    },

    degrees(a: ShaderInput): ShaderValue {
        return unaryCall('degrees', a);
    },

    radians(a: ShaderInput): ShaderValue {
        return unaryCall('radians', a);
    },

    ceil(a: ShaderInput): ShaderValue {
        return unaryCall('ceil', a);
    },

    round(a: ShaderInput): ShaderValue {
        return unaryCall('round', a);
    },

    trunc(a: ShaderInput): ShaderValue {
        return unaryCall('trunc', a);
    },

    abs(a: ShaderInput): ShaderValue {
        return unaryCall('abs', a);
    },

    floor(a: ShaderInput): ShaderValue {
        return unaryCall('floor', a);
    },

    fract(a: ShaderInput): ShaderValue {
        return unaryCall('fract', a);
    },

    not(a: ShaderInput): ShaderValue {
        const ea = toExpr(a);
        return value(unary(ea.type, '!', ea));
    },

    any(a: ShaderInput): ShaderValue {
        return value(call(boolType(), 'any', [toExpr(a)]));
    },

    all(a: ShaderInput): ShaderValue {
        return value(call(boolType(), 'all', [toExpr(a)]));
    },

    /** `select(falseValue, trueValue, condition)`, matching WGSL argument order. */
    select(falseValue: ShaderInput, trueValue: ShaderInput, condition: ShaderInput): ShaderValue {
        const ef = toExpr(falseValue);
        const et = toExpr(trueValue);
        return value(call(combineType(ef.type, et.type), 'select', [ef, et, toExpr(condition)]));
    },

    textureSample(texture: ShaderInput, sampler: ShaderInput, coords: ShaderInput): ShaderValue {
        const texture_ = toExpr(texture);
        return value(sample(vecOf(texture_.type, 4), texture_, toExpr(sampler), toExpr(coords)));
    },

    /** Sample a texture at an explicit mip level. Extra arguments pass through. */
    textureSampleLevel(...args: ShaderInput[]): ShaderValue {
        return value(call(vecType('f32', 4), 'textureSampleLevel', args.map(toExpr)));
    },

    /** Atomically add to a storage-buffer atomic and return the previous value. */
    atomicAdd(pointer: ShaderInput, amount: ShaderInput): ShaderValue {
        return value(call(u32Type(), 'atomicAdd', [toExpr(pointer), toExpr(amount)]));
    },

    /** Atomically load a storage-buffer atomic. */
    atomicLoad(pointer: ShaderInput): ShaderValue {
        return value(call(u32Type(), 'atomicLoad', [toExpr(pointer)]));
    },

    /** Atomically store to a storage-buffer atomic (a statement). */
    atomicStore(pointer: ShaderInput, amount: ShaderInput): ReturnType<typeof exprStmt> {
        return exprStmt(call(u32Type(), 'atomicStore', [toExpr(pointer), toExpr(amount)]));
    },

    /**
     * Read a texel without a sampler (`textureLoad`). Depth textures yield an
     * `f32`; sampled and storage textures yield `vec4<f32>`. The optional third
     * argument is a mip level (sampled/depth) or array index.
     */
    textureLoad(texture: ShaderInput, coords: ShaderInput, level?: ShaderInput): ShaderValue {
        const t = toExpr(texture);
        const depth = t.type.kind === 'texture' && t.type.depth === true;
        const result: GpuType = depth ? f32Type() : vecType('f32', 4);
        const args = level === undefined ? [t, toExpr(coords)] : [t, toExpr(coords), toExpr(level)];
        return value(call(result, 'textureLoad', args));
    },

    /** Write a texel to a storage texture (`textureStore`, a statement). */
    textureStore(texture: ShaderInput, coords: ShaderInput, texel: ShaderInput): ReturnType<typeof exprStmt> {
        return exprStmt(call(f32Type(), 'textureStore', [toExpr(texture), toExpr(coords), toExpr(texel)]));
    },

    /** Dimensions of a texture or one of its mips, as `vec2<u32>`. */
    textureDimensions(texture: ShaderInput, level?: ShaderInput): ShaderValue {
        const args = level === undefined ? [toExpr(texture)] : [toExpr(texture), toExpr(level)];
        return value(call(vecType('u32', 2), 'textureDimensions', args));
    },

    discard(): ReturnType<typeof discardStmt> {
        return discardStmt();
    },
};

/** The typed `std` namespace. */
export const std: TypedStd = stdImpl as unknown as TypedStd;

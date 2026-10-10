/**
 * The typed authoring surface.
 *
 * `SV<V>` augments a shader value with a compile-time shape `V`: component
 * access and swizzles are checked by the type system, and native operators
 * keep working because the value is branded as a `number`. Use `std.mul` and
 * friends when the result of an operation must keep its shape; an expression
 * written with operators is typed `number` and cannot be indexed.
 *
 * The `TypedD`/`TypedStd` interfaces describe the `d` and `std` namespaces so a
 * shader body can be fully typed by reinterpreting the runtime namespace once
 * with `typedD`/`typedStd`.
 *
 * Static only. Nothing here exists at runtime; shader bodies are parsed, not
 * executed, so the `number` brand is an authoring fiction that costs nothing.
 */
import type { Scalar, Vec, Mat, Comp, Mul, Same } from './shape';
import type { GpuType } from '../types';
import type { GpuStruct } from '../schema/struct';

interface ShaderBuiltinLike {
    readonly __builtin: string;
    readonly type: GpuType;
}

interface ShaderLocationLike {
    readonly __location: number;
    readonly type: GpuType;
}

/** Any value accepted where shape does not matter: a number or a shader value. */
export type Input = number | SV<any>;

/** Component members of a value: swizzles for vectors, columns for matrices. */
type Members<V> = V extends Vec<Scalar, 2>
    ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly xy: SV<V>; readonly yx: SV<V> }
    : V extends Vec<Scalar, 3>
        ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly z: SV<Comp<V>>; readonly xy: SV<Vec<Comp<V>, 2>>; readonly xyz: SV<V> }
        : V extends Vec<Scalar, 4>
            ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly z: SV<Comp<V>>; readonly w: SV<Comp<V>>; readonly xyz: SV<Vec<Comp<V>, 3>> }
            : V extends Mat<Scalar, any, any>
                ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly z: SV<Comp<V>>; readonly w: SV<Comp<V>>; readonly columns: readonly SV<Comp<V>>[] }
                : {};

/** Operator methods, shape-checked. */
interface Ops<V> {
    add<O>(other: SV<O>): SV<Same<V, O>>;
    sub<O>(other: SV<O>): SV<Same<V, O>>;
    mul<O>(other: SV<O>): SV<Mul<V, O>>;
    div<O>(other: SV<O>): SV<Same<V, O>>;
}

/**
 * A shader value carrying its compile-time shape `V`.
 *
 * Branded as `number` so native operators are accepted. Operator results are
 * plain `number`; use the methods or `std` functions to keep the shape.
 */
export type SV<V = unknown> = number & Members<V> & Ops<V>;

/** A `d.f32`-style scalar member, usable as a field or called as a constructor. */
type ScalarCtor<C extends Scalar> = { readonly kind: 'scalar'; readonly scalar: C } & ((v?: Input) => SV<C>);

/** A `d.vec3f`-style vector member, with arity matched to its width. */
type VecCtor<C extends Scalar, N extends 2 | 3 | 4> = { readonly kind: 'vec'; readonly scalar: C; readonly width: N } & (N extends 2
    ? (a: Input, b: Input) => SV<Vec<C, 2>>
    : N extends 3
        ? (a: Input, b: Input, c: Input) => SV<Vec<C, 3>>
        : (a: Input, b: Input, c: Input, d: Input) => SV<Vec<C, 4>>);

/** A `d.mat4x4f`-style matrix member. */
type MatCtor<C extends Scalar, Cols extends 2 | 3 | 4, Rows extends 2 | 3 | 4> = { readonly kind: 'mat'; readonly scalar: C } & ((...args: Input[]) => SV<Mat<C, Cols, Rows>>);

/** The typed `d` namespace. */
export interface TypedD {
    readonly f32: ScalarCtor<'f32'>;
    readonly i32: ScalarCtor<'i32'>;
    readonly u32: ScalarCtor<'u32'>;
    readonly bool: ScalarCtor<'bool'>;
    readonly vec2f: VecCtor<'f32', 2>;
    readonly vec3f: VecCtor<'f32', 3>;
    readonly vec4f: VecCtor<'f32', 4>;
    readonly vec2u: VecCtor<'u32', 2>;
    readonly vec3u: VecCtor<'u32', 3>;
    readonly vec4u: VecCtor<'u32', 4>;
    readonly vec2i: VecCtor<'i32', 2>;
    readonly vec3i: VecCtor<'i32', 3>;
    readonly vec4i: VecCtor<'i32', 4>;
    readonly mat2x2f: MatCtor<'f32', 2, 2>;
    readonly mat3x3f: MatCtor<'f32', 3, 3>;
    readonly mat4x4f: MatCtor<'f32', 4, 4>;
    readonly location: (index: number, type: GpuType) => ShaderLocationLike;
    readonly builtin: Record<string, ShaderBuiltinLike>;
    readonly struct: (fields: Record<string, unknown>) => GpuStruct;
    readonly arrayOf: (element: GpuType, count: number) => GpuType;
    readonly atomic: (inner: GpuType) => GpuType;
}

/**
 * The typed `std` namespace.
 *
 * Each operation has a shape-carrying overload and a fallback overload so
 * results of native operators (typed `number`) can still be passed in.
 */
export interface TypedStd {
    mul<A, B>(a: SV<A>, b: SV<B>): SV<Mul<A, B>>;
    mul(a: Input, b: Input): SV<any>;
    add<A>(a: SV<A>, b: SV<A>): SV<A>;
    add(a: Input, b: Input): SV<any>;
    sub<A>(a: SV<A>, b: SV<A>): SV<A>;
    sub(a: Input, b: Input): SV<any>;
    div<A>(a: SV<A>, b: SV<A>): SV<A>;
    div(a: Input, b: Input): SV<any>;
    neg<A>(a: SV<A>): SV<A>;
    neg(a: Input): SV<any>;
    mod(a: Input, b: Input): SV<'f32'>;
    mix<A>(a: SV<A>, b: SV<A>, t: Input): SV<A>;
    mix(a: Input, b: Input, t: Input): SV<any>;
    clamp<A>(a: SV<A>, lo: Input, hi: Input): SV<A>;
    clamp(a: Input, lo: Input, hi: Input): SV<any>;
    saturate<A>(a: SV<A>): SV<A>;
    saturate(a: Input): SV<any>;
    min<A>(a: SV<A>, b: Input): SV<A>;
    min(a: Input, b: Input): SV<any>;
    max<A>(a: SV<A>, b: Input): SV<A>;
    max(a: Input, b: Input): SV<any>;
    abs<A>(a: SV<A>): SV<A>;
    abs(a: Input): SV<any>;
    floor<A>(a: SV<A>): SV<A>;
    floor(a: Input): SV<any>;
    ceil<A>(a: SV<A>): SV<A>;
    ceil(a: Input): SV<any>;
    fract<A>(a: SV<A>): SV<A>;
    fract(a: Input): SV<any>;
    sqrt<A>(a: SV<A>): SV<A>;
    sqrt(a: Input): SV<any>;
    pow(a: Input, b: Input): SV<'f32'>;
    step<A>(edge: Input, x: SV<A>): SV<A>;
    step(a: Input, b: Input): SV<any>;
    smoothstep<A>(e0: Input, e1: Input, x: SV<A>): SV<A>;
    smoothstep(a: Input, b: Input, c: Input): SV<any>;
    cos<C extends Scalar>(x: SV<C>): SV<C>;
    cos(x: Input): SV<any>;
    sin<C extends Scalar>(x: SV<C>): SV<C>;
    sin(x: Input): SV<any>;
    tan<C extends Scalar>(x: SV<C>): SV<C>;
    tan(x: Input): SV<any>;
    length(x: Input): SV<'f32'>;
    normalize<A extends Vec<Scalar, any>>(x: SV<A>): SV<A>;
    normalize(x: Input): SV<any>;
    dot(a: Input, b: Input): SV<'f32'>;
    cross(a: Input, b: Input): SV<Vec<'f32', 3>>;
    reflect<A extends Vec<Scalar, any>>(a: SV<A>, b: SV<A>): SV<A>;
    reflect(a: Input, b: Input): SV<any>;
    distance(a: Input, b: Input): SV<'f32'>;
    select<A>(f: SV<A>, t: SV<A>, cond: Input): SV<A>;
    select(f: Input, t: Input, cond: Input): SV<any>;
    textureSample(t: unknown, s: unknown, uv: Input): SV<Vec<'f32', 4>>;
    textureSampleLevel(t: unknown, s: unknown, uv: Input, level: Input): SV<Vec<'f32', 4>>;
    discard(): unknown;
}

/** Reinterpret a runtime `d` namespace as its typed surface. */
export function typedD<T>(value: T): TypedD & T {
    return value as TypedD & T;
}

/** Reinterpret a runtime `std` namespace as its typed surface. */
export function typedStd<T>(value: T): TypedStd & T {
    return value as TypedStd & T;
}

/**
 * The typed authoring surface.
 *
 * `SV<V>` augments a shader value with a compile-time shape `V`: component
 * access and swizzles are checked, and native operators keep working because
 * the value is branded as a `number`. Use `std.mul` and friends when the result
 * of an operation must keep its shape; an expression written with operators is
 * typed `number` and cannot be indexed.
 *
 * `TypedD`/`TypedStd` are the declared types of the `d` and `std` namespaces.
 * The runtime objects are built loosely (`any`) and reinterpreted by a cast at
 * their definition sites; intersecting a typed member with the runtime `any`
 * would collapse it back to `any`.
 *
 * Static only. Shader bodies are parsed, not executed, so the `number` brand is
 * an authoring fiction that costs nothing at runtime.
 */
import type { Scalar, Vec, Mat, Comp, Mul, Same, Struct } from './shape';
import type { GpuType } from '../types';
import type { Field } from '../schema/field';
import type { GpuStruct } from '../schema/struct';
import type { GpuBindGroupLayout } from '../resources/bind-group';
import type { ShaderValue } from './value';

/**
 * Any value accepted where shape does not matter: a number, a shaped shader
 * value, or the raw runtime `ShaderValue` (what `layout.$.name` and untyped
 * helpers produce, which carries no shape but is still a valid operand).
 */
export type Input = number | SV<any> | ShaderValue;

/** Marker for a stage builtin such as `position` or `instance_index`. */
interface BuiltinMarker {
    readonly __builtin: string;
    readonly __shape: unknown;
}

/** Marker for a vertex input location, carrying the field it was built from. */
export interface LocatedMarker<F = GpuValue> {
    readonly __location: number;
    readonly type: F;
}

/** The builtins each stage exposes, with their shapes. */
export interface BuiltinMap {
    readonly position: { readonly __builtin: 'position'; readonly type: GpuType; readonly __shape: Vec<'f32', 4> };
    readonly vertexIndex: { readonly __builtin: 'vertex_index'; readonly type: GpuType; readonly __shape: 'u32' };
    readonly vertex_index: { readonly __builtin: 'vertex_index'; readonly type: GpuType; readonly __shape: 'u32' };
    readonly instanceIndex: { readonly __builtin: 'instance_index'; readonly type: GpuType; readonly __shape: 'u32' };
    readonly instance_index: { readonly __builtin: 'instance_index'; readonly type: GpuType; readonly __shape: 'u32' };
    readonly frontFacing: { readonly __builtin: 'front_facing'; readonly type: GpuType; readonly __shape: 'bool' };
    readonly globalId: { readonly __builtin: 'global_invocation_id'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly global_invocation_id: { readonly __builtin: 'global_invocation_id'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly localId: { readonly __builtin: 'local_invocation_id'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly local_invocation_id: { readonly __builtin: 'local_invocation_id'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly workgroupId: { readonly __builtin: 'workgroup_id'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly workgroup_id: { readonly __builtin: 'workgroup_id'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly numWorkgroups: { readonly __builtin: 'num_workgroups'; readonly type: GpuType; readonly __shape: Vec<'u32', 3> };
    readonly [key: string]: { readonly __builtin: string; readonly type: GpuType; readonly __shape: unknown };
}

/** The compile-time shape recorded by a field, constructor, or marker. */
export type ShapeOfField<F> = F extends { readonly kind: 'vec'; readonly scalar: infer C extends Scalar; readonly width: infer N extends 2 | 3 | 4 }
    ? Vec<C, N>
    : F extends { readonly kind: 'mat'; readonly scalar: infer C extends Scalar; readonly cols: infer Cc extends 2 | 3 | 4; readonly rows: infer R extends 2 | 3 | 4 }
        ? Mat<C, Cc, R>
        : F extends { readonly kind: 'scalar'; readonly scalar: infer C extends Scalar }
            ? C
            : F extends { readonly __shape: infer S }
                ? S
                : F extends GpuStruct<infer G>
                    ? Struct<FieldShapes<G>>
                    : F extends { readonly type: infer T }
                        ? ShapeOfField<T>
                        : unknown;

/** The shape of a shader input/output entry. */
export type ShapeOfEntry<E> = E extends { readonly __shape: infer S } ? S : E extends { readonly type: infer T } ? ShapeOfField<T> : ShapeOfField<E>;

/** The typed `input` for a stage, from its `in` record. */
export type InputOf<In> = { readonly [K in keyof In]: SV<ShapeOfEntry<In[K]>> };

/** The shapes of every field in a struct schema. */
export type FieldShapes<F> = { readonly [K in keyof F]: ShapeOfField<F[K]> };

/** The value bound in a binding slot. Storage, textures and samplers stay loose. */
export type SlotValue<Spec> = Spec extends { readonly uniform: infer U }
    ? U extends GpuStruct<infer G>
        ? SV<Struct<FieldShapes<G>>>
        : SV<unknown>
    : any;

/** The values exposed by a bind group layout, by slot name. */
export type BindGroupOf<S> = { readonly [K in keyof S]: SlotValue<S[K]> };

/** The typed `bindings` for a stage, from its bind group layouts. */
export type BindingsOf<B> = { readonly [K in keyof B]: B[K] extends GpuBindGroupLayout<infer S> ? BindGroupOf<S> : any };

/** Component members of a value: swizzles for vectors, columns for matrices. */
type Members<V> = unknown extends V
    ? { readonly [key: string]: SV<any> }
    : V extends Vec<Scalar, 2>
    ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly xy: SV<V>; readonly yx: SV<V> }
    : V extends Vec<Scalar, 3>
        ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly z: SV<Comp<V>>; readonly xy: SV<Vec<Comp<V>, 2>>; readonly xyz: SV<V> }
        : V extends Vec<Scalar, 4>
            ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly z: SV<Comp<V>>; readonly w: SV<Comp<V>>; readonly xyz: SV<Vec<Comp<V>, 3>> }
            : V extends Mat<Scalar, any, any>
                ? { readonly x: SV<Comp<V>>; readonly y: SV<Comp<V>>; readonly z: SV<Comp<V>>; readonly w: SV<Comp<V>>; readonly columns: readonly SV<Comp<V>>[] }
                : V extends Struct<infer F>
                    ? { readonly [K in keyof F]: SV<F[K]> }
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

/** A field usable in a layout, which also constructs a value when called. */
type Fieldlike = Field<any, any>;

/** Any schema value accepted by declaration helpers. */
type GpuValue = Fieldlike | GpuStruct | GpuType;

/** A `d.f32`-style scalar member, usable as a field or called as a constructor. */
type ScalarCtor<C extends Scalar> = Fieldlike & { readonly kind: 'scalar'; readonly scalar: C } & ((v?: Input) => SV<C>);

/** A `d.vec3f`-style vector member, with arity matched to its width. */
type VecCtor<C extends Scalar, N extends 2 | 3 | 4> = Fieldlike & { readonly kind: 'vec'; readonly scalar: C; readonly width: N } & (N extends 2
    ? (a: Input, b: Input) => SV<Vec<C, 2>>
    : N extends 3
        ? (a: Input, b: Input, c: Input) => SV<Vec<C, 3>>
        : (a: Input, b: Input, c: Input, d: Input) => SV<Vec<C, 4>>);

/** A `d.mat4x4f`-style matrix member. */
type MatCtor<C extends Scalar, Cols extends 2 | 3 | 4, Rows extends 2 | 3 | 4> = Fieldlike & { readonly kind: 'mat'; readonly scalar: C; readonly cols: Cols; readonly rows: Rows } & ((...args: Input[]) => SV<Mat<C, Cols, Rows>>);

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
    readonly v2f: VecCtor<'f32', 2>;
    readonly v3f: VecCtor<'f32', 3>;
    readonly v4f: VecCtor<'f32', 4>;
    readonly m3x3f: MatCtor<'f32', 3, 3>;
    readonly m4x4f: MatCtor<'f32', 4, 4>;
    readonly array: (element: GpuValue, values: readonly SV<any>[]) => SV<any>;
    readonly arrayOf: (element: GpuValue, count: number) => Fieldlike;
    readonly atomic: (inner: GpuValue) => Fieldlike;
    readonly texture2d: () => any;
    readonly texture2dArray: () => any;
    readonly textureCube: () => any;
    readonly struct: (fields: Record<string, GpuValue>) => GpuStruct;
    readonly sizeOf: (type: GpuValue) => number;
    readonly alignOf: (type: GpuValue) => number;
    readonly builtin: BuiltinMap;
    readonly location: <F>(index: number, type: F) => LocatedMarker<F>;
}

/**
 * The typed `std` namespace.
 *
 * Each operation has a shape-carrying overload and a fallback overload so a
 * result of a native operator (typed `number`) can still be passed in.
 */
export interface TypedStd extends TypedD {
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
    lt(a: Input, b: Input): SV<'bool'>;
    lte(a: Input, b: Input): SV<'bool'>;
    gt(a: Input, b: Input): SV<'bool'>;
    gte(a: Input, b: Input): SV<'bool'>;
    eq(a: Input, b: Input): SV<'bool'>;
    not(a: Input): SV<'bool'>;
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
    select<A>(f: SV<A>, t: SV<A>, cond: Input | boolean): SV<A>;
    select(f: Input, t: Input, cond: Input | boolean): SV<any>;
    textureSample(t: unknown, s: unknown, uv: Input): SV<Vec<'f32', 4>>;
    textureSample(t: unknown, s: unknown, uv: Input, arrayIndex: Input): SV<Vec<'f32', 4>>;
    textureSampleLevel(t: unknown, s: unknown, uv: Input, level: Input): SV<Vec<'f32', 4>>;
    textureSampleLevel(t: unknown, s: unknown, uv: Input, arrayIndex: Input, level: Input): SV<Vec<'f32', 4>>;
    discard(): unknown;
    lightContribution(pos: Input, axis: Input, color: Input, params: Input, normal: Input, worldPos: Input): SV<Vec<'f32', 3>>;
    tonemap(color: Input): SV<Vec<'f32', 3>>;
}

/** The typed `d` and `std` namespaces. */
export interface TypedGpu {
    readonly d: TypedD;
    readonly std: TypedStd;
}

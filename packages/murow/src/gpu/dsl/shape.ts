/**
 * Type-level shapes for typed shader values.
 *
 * These describe a value's GPU shape without depending on any backend. They are
 * compile-time only: nothing here exists at runtime. A `ShaderValue` is
 * parameterised by one of these so component access, constructors, and
 * arithmetic can be checked by the type system.
 *
 * Pure types. No backend, no device.
 */

/** A scalar component type. */
export type Scalar = 'f32' | 'i32' | 'u32' | 'bool';

/** A short vector: `N` components of scalar `C`. */
export interface Vec<C extends Scalar, N extends 2 | 3 | 4> {
    readonly kind: 'vec';
    readonly comp: C;
    readonly width: N;
}

/** A matrix with `Cols` columns and `Rows` rows of scalar `C`. */
export interface Mat<C extends Scalar, Cols extends 2 | 3 | 4, Rows extends 2 | 3 | 4> {
    readonly kind: 'mat';
    readonly comp: C;
    readonly cols: Cols;
    readonly rows: Rows;
}

/** An array shape. */
export interface Arr<E> {
    readonly kind: 'array';
    readonly element: E;
}

/** A struct shape, keyed by field name. */
export interface Struct<F extends Record<string, unknown>> {
    readonly kind: 'struct';
    readonly fields: F;
}

/** Any shape. */
export type Shape = Scalar | Vec<Scalar, any> | Mat<Scalar, any, any> | Arr<any> | Struct<any>;

/** The scalar component of a shape (`f32` for vectors/matrices, `bool` for booleans). */
export type Comp<V> = V extends Scalar
    ? V
    : V extends Vec<infer C, any>
        ? C
        : V extends Mat<infer C, any, any>
            ? C
            : 'f32';

/** The element shape of an array, or the shape itself. */
export type Elem<V> = V extends Arr<infer E> ? E : V;

/** The result shape of `a * b` for the scalar/vector/matrix cases. */
export type Mul<A, B> = A extends Mat<Scalar, any, infer R>
    ? B extends Vec<Scalar, any>
        ? Vec<Comp<A>, R>
        : A
    : B extends Mat<Scalar, any, any>
        ? A
        : A extends Vec<Scalar, any>
            ? A
            : B extends Vec<Scalar, any>
                ? B
                : A;

/** The result shape of a component-wise binary op that requires matching shapes. */
export type Same<A, B> = A extends B ? A : B extends A ? B : A;

/** The result shape of a comparison, always a boolean scalar. */
export type Bool = 'bool';

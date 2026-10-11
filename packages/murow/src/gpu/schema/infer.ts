/**
 * Type-level helpers mapping a GPU schema to its host value shape.
 *
 * No runtime code: these functions erase completely, so type safety costs
 * nothing in the shipped bundle.
 */
import type { Field } from './field';

/** Host object type of a schema: one value per named field. */
export type Infer<S extends Record<string, Field<any, any>>> = {
    [K in keyof S]: S[K] extends Field<infer T, any> ? T : never;
};

/** Typed array kind backing a scalar field, when it has one. */
export type TypedArrayOf<F> = F extends Field<any, infer A>
    ? unknown extends A
        ? Float32Array
        : A
    : never;

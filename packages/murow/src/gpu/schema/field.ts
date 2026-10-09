/**
 * A GPU memory field descriptor.
 *
 * Describes one value in a GPU buffer: its byte size, alignment, how to read
 * and write it through a DataView, and its nil value. The GPU-aligned sibling
 * of the core binary codec field.
 *
 * `A` is a compile-time-only marker recording the host value shape, so typed
 * views can be inferred without casts. It is never read at runtime.
 */
import type { GpuType } from '../types';

export interface Field<T, A = T> {
    /** Byte size of the field. */
    readonly size: number;
    /** Required byte alignment (std140/std430 rules). */
    readonly align: number;
    /** The GPU type this field maps to. */
    readonly type: GpuType;
    /** Write `value` into `dv` at byte offset `offset`. */
    write(dv: DataView, offset: number, value: T): void;
    /** Read a value from `dv` at byte offset `offset`. */
    read(dv: DataView, offset: number): T;
    /** The nil (zero) value used to initialize buffers. */
    toNil(): T;
    /** Compile-time-only phantom marker for the host value shape. */
    readonly __host?: A;
}

/** A schema mapping names to fields. Iteration order defines the layout. */
export type Schema<T extends object> = {
    readonly [K in keyof T]: Field<T[K], any>;
};

/** Host value type of a field (type-level only). */
export type HostOf<F> = F extends Field<infer T, any> ? T : never;

/** Typed array kind of a field, when it is a scalar primitive. */
export type ArrayOf<F> = F extends Field<any, infer A>
    ? unknown extends A
        ? Float32Array
        : A
    : never;

/** Align `offset` up to `alignment`. */
export function alignUp(offset: number, alignment: number): number {
    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

/**
 * GPU array field helpers.
 *
 * A fixed array has a known count and a stride of `alignUp(elementSize,
 * elementAlign)`, matching std140 vector array padding. A dynamic array is
 * runtime-sized (storage buffer tail): it has no fixed byte size and is written
 * from the host value's length.
 */
import type { Field } from './field';
import { arrayStride } from './align';
import type { GpuType } from '../types';

/** Host element type of a field. */
export type ElementOf<F> = F extends Field<infer T, any> ? T : never;

/** A fixed-length array of `field`. */
export function arrayOf<F extends Field<any, any>>(
    field: F,
    count: number,
): Field<ElementOf<F>[], any> {
    const stride = arrayStride(field);
    const type: GpuType = { kind: 'array', element: field.type, count };
    return {
        size: stride * count,
        align: field.align,
        type,
        write(dv, offset, value) {
            for (let i = 0; i < count; i++) field.write(dv, offset + i * stride, value[i]);
        },
        read(dv, offset) {
            const out: ElementOf<F>[] = [];
            for (let i = 0; i < count; i++) out.push(field.read(dv, offset + i * stride));
            return out;
        },
        toNil() {
            const out: ElementOf<F>[] = [];
            for (let i = 0; i < count; i++) out.push(field.toNil());
            return out;
        },
    };
}

/**
 * A runtime-sized array of `field`. `size` is one element's stride; the layout
 * of a dynamic array is resolved by the storage buffer that contains it.
 */
export function dynamicArrayOf<F extends Field<any, any>>(field: F): Field<ElementOf<F>[], any> {
    const stride = arrayStride(field);
    const type: GpuType = { kind: 'array', element: field.type, count: null };
    return {
        size: stride,
        align: field.align,
        type,
        write(dv, offset, value) {
            for (let i = 0; i < value.length; i++) {
                field.write(dv, offset + i * stride, value[i]);
            }
        },
        read() {
            return [];
        },
        toNil() {
            return [];
        },
    };
}

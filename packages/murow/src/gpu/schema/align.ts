/**
 * std140 and std430 layout rules for GPU schema fields.
 *
 * Offsets are computed by aligning each field to its own alignment, in order.
 * The struct alignment is the maximum member alignment. std140 rounds the
 * struct alignment and total size up to 16 bytes (uniform buffers); std430
 * leaves them at the member alignment so storage buffers pack tighter.
 */
import { alignUp, type Field } from './field';

export { alignUp };

/** Buffer packing rules. */
export type Packing = 'std140' | 'std430';

/** Standard uniform buffer packing. */
export const Std140: Packing = 'std140';
/** Tightly packed storage buffer packing. */
export const Std430: Packing = 'std430';

/** A field paired with its member name. */
export interface NamedField {
    readonly name: string;
    readonly field: Field<any, any>;
}

/** A field placed at a byte offset within a struct. */
export interface FieldLayout {
    readonly name: string;
    readonly offset: number;
    readonly field: Field<any, any>;
}

/** The computed layout of a struct or a list of fields. */
export interface Layout {
    readonly fields: FieldLayout[];
    readonly size: number;
    readonly align: number;
    readonly packing: Packing;
}

/** Byte stride of a fixed or runtime-sized array of `field`. */
export function arrayStride(field: Field<any, any>): number {
    return alignUp(field.size, field.align);
}

/**
 * Place `fields` in order under `packing`, returning each offset, the total
 * size, and the struct alignment.
 */
export function structLayout(fields: readonly NamedField[], packing: Packing = Std140): Layout {
    const laid: FieldLayout[] = [];
    let offset = 0;
    let memberAlign = 1;

    for (const { name, field } of fields) {
        offset = alignUp(offset, field.align);
        laid.push({ name, offset, field });
        offset += field.size;
        if (field.align > memberAlign) memberAlign = field.align;
    }

    const align = packing === Std140 ? alignUp(memberAlign, 16) : memberAlign;
    return { fields: laid, size: alignUp(offset, align), align, packing };
}

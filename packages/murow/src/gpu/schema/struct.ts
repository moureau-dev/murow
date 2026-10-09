/**
 * GPU struct schema.
 *
 * A `GpuStruct` computes the std140 or std430 layout of named fields, owns a
 * backing buffer, and exposes a typed mirror: reading a field name reads its
 * bytes, writing a field name writes them and marks the backing dirty. The
 * backing is uploaded as-is, so no per-frame allocation is needed.
 */
import type { Field } from './field';
import { Std140, structLayout, type FieldLayout, type Packing } from './align';
import type { StructType } from '../types';
import type { TargetSyntax } from '../codegen/syntax';

/** A field paired with its member name. */
export interface StructField {
    readonly name: string;
    readonly field: Field<any, any>;
}

/** Options for `new GpuStruct(...)`. */
export interface GpuStructOptions {
    /** Struct name used in emitted source. */
    readonly name: string;
    /** Fields in layout order. A record is laid out in key insertion order. */
    readonly fields: readonly StructField[] | Record<string, Field<any, any>>;
    /** Packing rules. Defaults to std140. */
    readonly packing?: Packing;
}

function normalizeFields(
    fields: readonly StructField[] | Record<string, Field<any, any>>,
): StructField[] {
    if (Array.isArray(fields)) return fields.slice();
    return Object.keys(fields).map((name) => ({ name, field: fields[name] }));
}

export class GpuStruct {
    /** Struct name used in emitted source. */
    readonly name: string;
    /** Fields with their computed byte offsets, in layout order. */
    readonly fields: readonly FieldLayout[];
    /** Total byte size, including trailing padding. */
    readonly size: number;
    /** Struct alignment. */
    readonly align: number;
    /** Packing rules used to compute the layout. */
    readonly packing: Packing;

    /** Typed view over the backing buffer. Reads and writes field values. */
    readonly mirror: Record<string, any>;

    private readonly backing: ArrayBuffer;
    private readonly view: DataView;
    private _dirty = true;

    constructor(options: GpuStructOptions) {
        this.name = options.name;
        this.packing = options.packing ?? Std140;

        const named = normalizeFields(options.fields);
        const layout = structLayout(named, this.packing);

        this.fields = layout.fields;
        this.size = layout.size;
        this.align = layout.align;
        this.backing = new ArrayBuffer(this.size);
        this.view = new DataView(this.backing);

        for (const member of this.fields) {
            member.field.write(this.view, member.offset, member.field.toNil());
        }

        this.mirror = this.createMirror();
    }

    /** The GPU type descriptor for this struct. */
    get type(): StructType {
        return {
            kind: 'struct',
            name: this.name,
            fields: this.fields.map((member) => ({ name: member.name, type: member.field.type })),
        };
    }

    /** Whether the backing has changed since the last `clearDirty`. */
    get dirty(): boolean {
        return this._dirty;
    }

    /** Mark the backing clean after an upload. */
    clearDirty(): void {
        this._dirty = false;
    }

    /** The backing buffer to upload. */
    createBacking(): ArrayBuffer {
        return this.backing;
    }

    /** Layout for one field by name, or undefined. */
    member(name: string): FieldLayout | undefined {
        for (const member of this.fields) {
            if (member.name === name) return member;
        }
        return undefined;
    }

    /** Struct declaration in the given target syntax. */
    text(syntax: TargetSyntax): string {
        return syntax.structDecl(this.type);
    }

    private createMirror(): Record<string, any> {
        const self = this;
        const target: Record<string, any> = {};
        return new Proxy(target, {
            get(_target, property) {
                if (typeof property !== 'string') return undefined;
                const member = self.member(property);
                if (!member) return undefined;
                return member.field.read(self.view, member.offset);
            },
            set(_target, property, value) {
                if (typeof property !== 'string') return false;
                const member = self.member(property);
                if (!member) return false;
                member.field.write(self.view, member.offset, value);
                self._dirty = true;
                return true;
            },
            has(_target, property) {
                return typeof property === 'string' && self.member(property) !== undefined;
            },
            ownKeys() {
                return self.fields.map((member) => member.name);
            },
            getOwnPropertyDescriptor() {
                return { enumerable: true, configurable: true, writable: true, value: undefined };
            },
        });
    }
}

/** Create a `GpuStruct` from its options. */
export function gpuStruct(options: GpuStructOptions): GpuStruct {
    return new GpuStruct(options);
}

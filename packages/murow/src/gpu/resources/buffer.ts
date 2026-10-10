/**
 * Typed GPU buffers.
 *
 * A {@link GpuBuffer} is schema-aware: writing a value packs it into bytes
 * through the schema's fields. The raw handle stays behind the device.
 */
import type { GpuStruct } from '../schema/struct';
import type { Field } from '../schema/field';
import type { GpuDevice, GpuBuffer as GpuBufferHandle, BufferUsage } from '../device/gpu-device';

/** A schema value: a struct block or a single field. */
export type BufferSchema<T = unknown> = GpuStruct | Field<T, any>;

/** Byte size of a schema value. */
function schemaSize(schema: BufferSchema): number {
    return schema.size;
}

/** Pack a value into bytes against a schema. Views and buffers pass through. */
function encode(schema: BufferSchema, value: unknown, size: number): ArrayBufferView {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return value;
    const buffer = new ArrayBuffer(size);
    const dv = new DataView(buffer);
    if (isStruct(schema)) {
        for (const member of schema.fields) {
            member.field.write(dv, member.offset, (value as Record<string, unknown>)?.[member.name]);
        }
    } else {
        (schema as Field<unknown, any>).write(dv, 0, value);
    }
    return new Uint8Array(buffer);
}

function isStruct(schema: BufferSchema): schema is GpuStruct {
    return Array.isArray((schema as GpuStruct).fields);
}

/**
 * A schema-typed buffer. Construct through {@link GpuContext.createBuffer}.
 */
export class GpuBuffer<T = unknown> {
    /** Schema this buffer was sized from. */
    readonly schema: BufferSchema<T>;
    /** Byte size. */
    readonly size: number;

    private readonly device: GpuDevice;
    private readonly handle: GpuBufferHandle;

    constructor(device: GpuDevice, schema: BufferSchema<T>, usage: BufferUsage) {
        this.device = device;
        this.schema = schema;
        this.size = schemaSize(schema);
        this.handle = isStruct(schema)
            ? device.createBuffer({ struct: schema })
            : device.createBuffer({ size: this.size, usage });
    }

    /** Upload a value at offset zero. */
    write(value: T | ArrayBufferView): void {
        this.device.writeBuffer(this.handle, 0, encode(this.schema, value, this.size));
    }

    /** Release the buffer. */
    destroy(): void {
        this.device.destroyBuffer(this.handle);
    }

    /** The backend buffer handle, for bind groups and direct device use. */
    asHandle(): GpuBufferHandle {
        return this.handle;
    }
}

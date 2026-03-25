/**
 * A binary field descriptor.
 * Defines how a single value is serialized/deserialized
 * at a fixed byte size.
 */
export type Field<T> = {
    /** Size of the field in bytes */
    size: number;
    /**
     * Writes a value into a DataView at the given offset.
     * @param dv DataView to write into
     * @param o Byte offset
     * @param v Value to write
     */
    write(dv: DataView, o: number, v: T): void;
    /**
     * Reads a value from a DataView at the given offset.
     * @param dv DataView to read from
     * @param o Byte offset
     */
    read(dv: DataView, o: number): T;
    /**
     * Returns the nil value
     */
    toNil(): T;
};
/**
 * A schema mapping object keys to binary fields.
 * The order of iteration defines the binary layout.
 *
 * IMPORTANT:
 * Property order is respected as insertion order.
 * Do not rely on computed or dynamic keys.
 */
export type Schema<T> = {
    [K in keyof T]: Field<T[K]>;
};
/**
 * Base codec implementation.
 * Handles schema-driven encoding/decoding.
 */
export declare class BaseBinaryCodec {
    /**
     * Encodes an object into a binary buffer using the given schema.
     *
     * Allocates a right-sized buffer per call.
     * Safe for concurrent and re-entrant usage.
     *
     * @param schema Binary schema definition
     * @param data Object to encode
     * @returns A Uint8Array containing the encoded bytes
     */
    protected static encodeInto<T extends object>(schema: Schema<T>, data: T): Uint8Array;
    /**
     * Decodes a binary buffer into a target object using the given schema.
     *
     * Validates buffer size before reading.
     * Does not mutate shared state.
     *
     * @param schema Binary schema definition
     * @param buf Buffer containing encoded data
     * @param target Target object to mutate
     * @returns The mutated target object
     */
    static decodeInto<T extends object>(schema: Schema<T>, buf: Uint8Array, target: T): T;
}
/**
 * Built-in binary primitive field definitions for multiplayer games.
 */
export declare class BinaryPrimitives {
    /** Unsigned 8-bit integer */
    static readonly u8: Field<number>;
    /** Unsigned 16-bit integer (big-endian) */
    static readonly u16: Field<number>;
    /** Unsigned 32-bit integer (big-endian) */
    static readonly u32: Field<number>;
    /** Signed 8-bit integer */
    static readonly i8: Field<number>;
    /** Signed 16-bit integer (big-endian) */
    static readonly i16: Field<number>;
    /** Signed 32-bit integer (big-endian) */
    static readonly i32: Field<number>;
    /** 16-bit floating point number (IEEE 754, big-endian) */
    static readonly f16: Field<number>;
    /** 32-bit floating point number (IEEE 754, big-endian) */
    static readonly f32: Field<number>;
    /** 64-bit floating point number (double, big-endian) */
    static readonly f64: Field<number>;
    /** Boolean stored as 1 byte (0 = false, 1 = true) */
    static readonly bool: Field<boolean>;
    /**
     * String field with UTF-8 encoding and 2-byte length prefix.
     * @param maxLength Maximum number of bytes allowed
     */
    static string(maxLength: number): Field<string>;
    /** 2D vector of f32 (x, y) */
    static readonly vec2: Field<{
        x: number;
        y: number;
    }>;
    /** 3D vector of f32 (x, y, z) */
    static readonly vec3: Field<{
        x: number;
        y: number;
        z: number;
    }>;
    /** RGBA color packed as 4 u8 bytes */
    static readonly color: Field<{
        r: number;
        g: number;
        b: number;
        a: number;
    }>;
    /** 32-bit floating point number (IEEE 754, little-endian) */
    static readonly f32_le: Field<number>;
    /** 64-bit floating point number (double, little-endian) */
    static readonly f64_le: Field<number>;
    /** Unsigned 16-bit integer (little-endian) */
    static readonly u16_le: Field<number>;
    /** Unsigned 32-bit integer (little-endian) */
    static readonly u32_le: Field<number>;
    /** Signed 16-bit integer (little-endian) */
    static readonly i16_le: Field<number>;
    /** Signed 32-bit integer (little-endian) */
    static readonly i32_le: Field<number>;
    /**
     * 2D vector of f32 stored as a tuple [x, y] (little-endian).
     * Useful for compact math data or shader-friendly layouts.
     */
    static readonly vec2_le: Field<[number, number]>;
    /**
     * 3D vector of f32 stored as a tuple [x, y, z] (little-endian).
     * Commonly used for positions, velocities, or directions.
     */
    static readonly vec3_le: Field<[number, number, number]>;
    /**
     * 4D vector of f32 stored as a tuple [x, y, z, w] (little-endian).
     * Useful for quaternions, colors in shaders, or homogeneous coordinates.
     */
    static readonly vec4_le: Field<[number, number, number, number]>;
}
/**
 * Public codec API.
 * Re-exports primitives and exposes encode/decode helpers.
 */
export declare class BinaryCodec extends BaseBinaryCodec {
    /** Unsigned 8-bit integer field */
    static readonly u8: Field<number>;
    /** Unsigned 16-bit integer field */
    static readonly u16: Field<number>;
    /** Unsigned 32-bit integer field */
    static readonly u32: Field<number>;
    /** Signed 8-bit integer field */
    static readonly i8: Field<number>;
    /** Signed 16-bit integer field */
    static readonly i16: Field<number>;
    /** Signed 32-bit integer field */
    static readonly i32: Field<number>;
    /** 16-bit floating point field */
    static readonly f16: Field<number>;
    /** 32-bit floating point field */
    static readonly f32: Field<number>;
    /** Boolean field */
    static readonly bool: Field<boolean>;
    /** String field with length prefix */
    static string: typeof BinaryPrimitives.string;
    /** 2D vector field */
    static readonly vec2: Field<{
        x: number;
        y: number;
    }>;
    /** 3D vector field */
    static readonly vec3: Field<{
        x: number;
        y: number;
        z: number;
    }>;
    /** RGBA color field */
    static readonly color: Field<{
        r: number;
        g: number;
        b: number;
        a: number;
    }>;
    /**
     * Encodes an object into a binary buffer.
     */
    static encode<T extends object>(schema: Schema<T>, data: T): Uint8Array;
    /**
     * Decodes a binary buffer into an existing object.
     */
    static decode<T extends object>(schema: Schema<T>, buf: Uint8Array, target: T): T;
}

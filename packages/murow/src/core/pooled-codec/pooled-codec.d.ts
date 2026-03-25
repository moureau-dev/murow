import { Schema, Field } from "../binary-codec";
/**
 * Type marker for array fields in schemas.
 *
 * ArrayField now implements both the Field interface (for use in schemas)
 * and the Codec interface (for standalone use), making it versatile enough
 * to be used directly with SnapshotRegistry or as a field in PooledCodec schemas.
 */
export type ArrayField<T> = {
    __arrayType?: T[];
    encode(items: T[]): Uint8Array;
    decode(buf: Uint8Array): T[];
    decodeField(buf: Uint8Array): {
        value: T[];
        bytesRead: number;
    };
    toNil(): T[];
    calculateSize(items: T[]): number;
    encodeInto(items: T[], buffer: Uint8Array, offset: number): number;
};
/**
 * Extended schema type that supports both regular fields and array fields
 */
export type ExtendedSchema<T> = {
    [K in keyof T]: T[K] extends any[] ? ArrayField<T[K][number]> : Field<T[K]>;
};
/**
 * Infer the type from a schema definition
 */
type InferSchemaType<S> = {
    [K in keyof S]: S[K] extends ArrayField<infer U> ? U[] : S[K] extends Field<infer V> ? V : unknown;
};
/**
 * Generic object pool for reusing objects and minimizing allocations.
 * @template T Type of objects stored in the pool.
 */
export declare class ObjectPool<T> {
    private factory;
    private pool;
    /**
     * @param factory Function to create a new instance when the pool is empty.
     */
    constructor(factory: () => T);
    /**
     * Acquire an object from the pool, or create a new one if empty.
     * @returns {T} The acquired object.
     */
    acquire(): T;
    /**
     * Return an object to the pool for reuse.
     * @param {T} obj Object to release.
     */
    release(obj: T): void;
    /**
     * Return multiple objects to the pool at once.
     * @param {T[]} objs Array of objects to release.
     */
    releaseAll(objs: T[]): void;
}
/**
 * Pooled decoder for single objects or nested schemas.
 * @template T Type of object to decode.
 */
export declare class PooledDecoder<T extends object> {
    private schema;
    private pool;
    /**
     * @param schema Schema or record describing the object structure.
     * @param initial Initial object used as template for pooling.
     */
    constructor(schema: Schema<T> | Record<string, any>);
    private createNil;
    /**
     * Decode a buffer into a pooled object.
     * @param {Uint8Array} buf Buffer to decode.
     * @returns {T} Decoded object.
     */
    decode(buf: Uint8Array): T;
    /**
     * Decode a buffer into a provided target object.
     * @param {Uint8Array} buf Buffer to decode.
     * @param {T} target Object to write decoded data into.
     */
    decodeInto(buf: Uint8Array, target: T): void;
    /**
     * Release a decoded object back to the pool.
     * @param {T} obj Object to release.
     */
    release(obj: T): void;
}
/**
 * Pooled decoder for arrays of objects.
 * @template T Type of object to decode.
 */
export declare class PooledArrayDecoder<T extends object> {
    private pooledDecoder;
    /**
     * @param schema Schema or record describing object structure.
     * @param initial Initial object used as template for pooling.
     */
    constructor(schema: Schema<T> | Record<string, any>);
    /**
     * Decode multiple buffers into pooled objects.
     * @param {Uint8Array[]} buffers Array of buffers to decode.
     * @returns {T[]} Array of decoded objects.
     */
    decodeAll(buffers: Uint8Array[]): T[];
    /**
     * Release multiple decoded objects back to the pool.
     * @param {T[]} objs Array of objects to release.
     */
    releaseAll(objs: T[]): void;
}
/**
 * Pooled encoder for single objects or nested schemas.
 * @template T Type of object to encode.
 */
export declare class PooledEncoder<T extends object> {
    private schema;
    private bufferSize;
    private pool;
    /**
     * @param schema Schema or record describing object structure.
     * @param bufferSize Size of buffer to allocate per encoding (default: 1024).
     */
    constructor(schema: Schema<T> | Record<string, any>, bufferSize?: number);
    /**
     * Encode an object into a pooled buffer.
     * @param {T} obj Object to encode.
     * @returns {Uint8Array} Encoded buffer.
     */
    encode(obj: T): Uint8Array;
    /**
     * Release a buffer back to the pool.
     * @param {Uint8Array} buf Buffer to release.
     */
    release(buf: Uint8Array): void;
}
/**
 * Combined pooled encoder and decoder for a single schema.
 * Provides a convenient wrapper around PooledEncoder and PooledDecoder.
 * @template S Schema type
 */
export declare class PooledCodec<S extends Record<string, any>> {
    schema: S;
    /** Pooled encoder for the schema */
    encoder: PooledEncoder<any>;
    /** Pooled decoder for the schema */
    decoder: PooledDecoder<any>;
    /**
     * @param schema Schema describing the object structure.
     */
    constructor(schema: S);
    /**
     * Calculate the size in bytes needed to encode the data.
     * @param data Object to calculate size for.
     * @returns Size in bytes.
     */
    calculateSize(data: InferSchemaType<S>): number;
    /**
     * Encode an object directly into a target buffer at the given offset.
     * This is a zero-copy operation - no intermediate buffers are allocated.
     * @param data Object to encode.
     * @param buffer Target buffer to write into.
     * @param offset Byte offset in the buffer to start writing.
     * @returns Number of bytes written.
     */
    encodeInto(data: InferSchemaType<S>, buffer: Uint8Array, offset: number): number;
    /**
     * Encode an object into a pooled buffer.
     * @param data Object to encode.
     * @returns Encoded buffer.
     */
    encode(data: InferSchemaType<S>): Uint8Array;
    /**
     * Decode a buffer into a pooled object.
     * @param buf Buffer to decode.
     * @returns Decoded object.
     */
    decode(buf: Uint8Array): InferSchemaType<S>;
    /**
     * Release a decoded object back to the pool.
     * @param obj Object to release.
     */
    release(obj: InferSchemaType<S>): void;
    /**
     * Creates an array field descriptor for use in schemas.
     * Encodes array length as u16 followed by each item.
     *
     * @template U Type of items in the array
     * @param itemSchema Schema for individual array items
     * @returns An array field descriptor that can be used in PooledCodec schemas
     *
     * @example
     * ```ts
     * const PlayerSchema = {
     *   entityId: BinaryPrimitives.u32,
     *   x: BinaryPrimitives.f32,
     *   y: BinaryPrimitives.f32,
     * };
     *
     * const UpdateSchema = {
     *   tick: BinaryPrimitives.u32,
     *   players: PooledCodec.array(PlayerSchema),
     * };
     *
     * const codec = new PooledCodec(UpdateSchema);
     * ```
     */
    static array<U extends object>(itemSchema: Schema<U> | Record<string, any>): ArrayField<U>;
}
export {};

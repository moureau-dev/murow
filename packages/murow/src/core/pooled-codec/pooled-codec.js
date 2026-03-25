import { BinaryCodec } from "../binary-codec";
/**
 * Generic object pool for reusing objects and minimizing allocations.
 * @template T Type of objects stored in the pool.
 */
export class ObjectPool {
    /**
     * @param factory Function to create a new instance when the pool is empty.
     */
    constructor(factory) {
        this.factory = factory;
        this.pool = [];
    }
    /**
     * Acquire an object from the pool, or create a new one if empty.
     * @returns {T} The acquired object.
     */
    acquire() {
        return this.pool.pop() ?? this.factory();
    }
    /**
     * Return an object to the pool for reuse.
     * @param {T} obj Object to release.
     */
    release(obj) {
        this.pool.push(obj);
    }
    /**
     * Return multiple objects to the pool at once.
     * @param {T[]} objs Array of objects to release.
     */
    releaseAll(objs) {
        this.pool.push(...objs);
    }
}
/**
 * Pooled decoder for single objects or nested schemas.
 * @template T Type of object to decode.
 */
export class PooledDecoder {
    /**
     * @param schema Schema or record describing the object structure.
     * @param initial Initial object used as template for pooling.
     */
    constructor(schema) {
        this.schema = schema;
        this.pool = new ObjectPool(() => this.createNil());
    }
    createNil() {
        const obj = {};
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            obj[key] = "toNil" in field ? field.toNil() : undefined;
        }
        return obj;
    }
    /**
     * Decode a buffer into a pooled object.
     * @param {Uint8Array} buf Buffer to decode.
     * @returns {T} Decoded object.
     */
    decode(buf) {
        const obj = this.pool.acquire();
        this.decodeInto(buf, obj);
        return obj;
    }
    /**
     * Decode a buffer into a provided target object.
     * @param {Uint8Array} buf Buffer to decode.
     * @param {T} target Object to write decoded data into.
     */
    decodeInto(buf, target) {
        let offset = 0;
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            if ("decodeAll" in field) {
                const result = field.decodeAll(buf.subarray(offset));
                target[key] = result.value;
                offset += result.bytesRead;
            }
            else if ("decodeField" in field) {
                // Use decodeField for ArrayField (returns { value, bytesRead })
                const result = field.decodeField(buf.subarray(offset));
                target[key] = result.value;
                offset += result.bytesRead;
            }
            else if ("decode" in field) {
                const result = field.decode(buf.subarray(offset));
                target[key] = result.value;
                offset += result.bytesRead;
            }
            else {
                // For primitive fields, calculate size and decode
                const fieldSize = field.size || 0;
                const fieldBuf = buf.subarray(offset, offset + fieldSize);
                BinaryCodec.decodeInto({ [key]: field }, fieldBuf, target);
                offset += fieldSize;
            }
        }
    }
    /**
     * Release a decoded object back to the pool.
     * @param {T} obj Object to release.
     */
    release(obj) {
        this.pool.release(obj);
    }
}
/**
 * Pooled decoder for arrays of objects.
 * @template T Type of object to decode.
 */
export class PooledArrayDecoder {
    /**
     * @param schema Schema or record describing object structure.
     * @param initial Initial object used as template for pooling.
     */
    constructor(schema) {
        this.pooledDecoder = new PooledDecoder(schema);
    }
    /**
     * Decode multiple buffers into pooled objects.
     * @param {Uint8Array[]} buffers Array of buffers to decode.
     * @returns {T[]} Array of decoded objects.
     */
    decodeAll(buffers) {
        return buffers.map((b) => this.pooledDecoder.decode(b));
    }
    /**
     * Release multiple decoded objects back to the pool.
     * @param {T[]} objs Array of objects to release.
     */
    releaseAll(objs) {
        objs.forEach((o) => this.pooledDecoder.release(o));
    }
}
/**
 * Pooled encoder for single objects or nested schemas.
 * @template T Type of object to encode.
 */
export class PooledEncoder {
    /**
     * @param schema Schema or record describing object structure.
     * @param bufferSize Size of buffer to allocate per encoding (default: 1024).
     */
    constructor(schema, bufferSize = 1024) {
        this.schema = schema;
        this.bufferSize = bufferSize;
        this.pool = new ObjectPool(() => new Uint8Array(bufferSize));
    }
    /**
     * Encode an object into a pooled buffer.
     * @param {T} obj Object to encode.
     * @returns {Uint8Array} Encoded buffer.
     */
    encode(obj) {
        const buf = this.pool.acquire();
        let offset = 0;
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            if ("encode" in field) {
                const nested = field.encode(obj[key]);
                buf.set(nested, offset);
                offset += nested.length;
            }
            else if ("encodeAll" in field) {
                const nestedArr = field.encodeAll(obj[key]);
                let arrOffset = 0;
                for (const item of nestedArr) {
                    buf.set(item, offset + arrOffset);
                    arrOffset += item.length;
                }
                offset += arrOffset;
            }
            else {
                const tmp = BinaryCodec.encode({ [key]: field }, { [key]: obj[key] });
                buf.set(tmp, offset);
                offset += tmp.length;
            }
        }
        return buf.subarray(0, offset);
    }
    /**
     * Release a buffer back to the pool.
     * @param {Uint8Array} buf Buffer to release.
     */
    release(buf) {
        this.pool.release(buf);
    }
}
/**
 * Combined pooled encoder and decoder for a single schema.
 * Provides a convenient wrapper around PooledEncoder and PooledDecoder.
 * @template S Schema type
 */
export class PooledCodec {
    /**
     * @param schema Schema describing the object structure.
     */
    constructor(schema) {
        this.schema = schema;
        this.encoder = new PooledEncoder(schema);
        this.decoder = new PooledDecoder(schema);
    }
    /**
     * Calculate the size in bytes needed to encode the data.
     * @param data Object to calculate size for.
     * @returns Size in bytes.
     */
    calculateSize(data) {
        let size = 0;
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            if ("size" in field) {
                // Fixed-size primitive field
                size += field.size;
            }
            else if ("calculateSize" in field) {
                // Variable-size field (like arrays)
                size += field.calculateSize(data[key]);
            }
        }
        return size;
    }
    /**
     * Encode an object directly into a target buffer at the given offset.
     * This is a zero-copy operation - no intermediate buffers are allocated.
     * @param data Object to encode.
     * @param buffer Target buffer to write into.
     * @param offset Byte offset in the buffer to start writing.
     * @returns Number of bytes written.
     */
    encodeInto(data, buffer, offset) {
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        let currentOffset = offset;
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            if ("write" in field) {
                // Primitive field - direct write
                field.write(view, currentOffset, data[key]);
                currentOffset += field.size;
            }
            else if ("encodeInto" in field) {
                // Array or nested field - delegate to its encodeInto
                const bytesWritten = field.encodeInto(data[key], buffer, currentOffset);
                currentOffset += bytesWritten;
            }
            else if ("encode" in field) {
                // Fallback for fields that only have encode()
                const nested = field.encode(data[key]);
                buffer.set(nested, currentOffset);
                currentOffset += nested.length;
            }
        }
        return currentOffset - offset; // bytes written
    }
    /**
     * Encode an object into a pooled buffer.
     * @param data Object to encode.
     * @returns Encoded buffer.
     */
    encode(data) {
        return this.encoder.encode(data);
    }
    /**
     * Decode a buffer into a pooled object.
     * @param buf Buffer to decode.
     * @returns Decoded object.
     */
    decode(buf) {
        return this.decoder.decode(buf);
    }
    /**
     * Release a decoded object back to the pool.
     * @param obj Object to release.
     */
    release(obj) {
        this.decoder.release(obj);
    }
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
    static array(itemSchema) {
        // Calculate item size once
        let itemSize = 0;
        for (const key of Object.keys(itemSchema)) {
            const field = itemSchema[key];
            itemSize += field.size || 0;
        }
        // Pool for encoding buffers (larger initial size to avoid allocations)
        const bufferPool = new ObjectPool(() => new Uint8Array(16384));
        // Pool for decoded objects to avoid allocations
        const objectPool = new ObjectPool(() => {
            const obj = {};
            for (const key of Object.keys(itemSchema)) {
                const field = itemSchema[key];
                obj[key] = ("toNil" in field ? field.toNil() : undefined);
            }
            return obj;
        });
        // Pool for result arrays to avoid allocations
        const arrayPool = new ObjectPool(() => []);
        // Reusable DataView for encoding
        let encodeView = null;
        // Reusable DataView for decoding
        let decodeView = null;
        return {
            __arrayType: undefined,
            calculateSize(items) {
                return 2 + (items.length * itemSize);
            },
            encodeInto(items, buffer, offset) {
                const view = new DataView(buffer.buffer, buffer.byteOffset);
                // Write array length
                view.setUint16(offset, items.length, false);
                let currentOffset = offset + 2;
                // Write each item directly into buffer
                for (const item of items) {
                    for (const key of Object.keys(itemSchema)) {
                        const field = itemSchema[key];
                        field.write(view, currentOffset, item[key]);
                        currentOffset += field.size;
                    }
                }
                return currentOffset - offset; // bytes written
            },
            encode(items) {
                const totalSize = 2 + (items.length * itemSize);
                let buffer = bufferPool.acquire();
                // Grow buffer pool if needed (but keep the undersized buffer for next time)
                if (buffer.length < totalSize) {
                    bufferPool.release(buffer);
                    buffer = new Uint8Array(Math.max(totalSize, buffer.length * 2));
                }
                // Create or reuse DataView for this buffer
                if (!encodeView || encodeView.buffer !== buffer.buffer) {
                    encodeView = new DataView(buffer.buffer, buffer.byteOffset);
                }
                // Write array length
                encodeView.setUint16(0, items.length, false);
                // Write each item directly into buffer (zero intermediate allocations)
                let offset = 2;
                for (const item of items) {
                    for (const key of Object.keys(itemSchema)) {
                        const field = itemSchema[key];
                        field.write(encodeView, offset, item[key]);
                        offset += field.size;
                    }
                }
                // Create a copy to return (caller owns this memory)
                const result = new Uint8Array(offset);
                result.set(buffer.subarray(0, offset));
                // Return buffer to pool
                bufferPool.release(buffer);
                return result;
            },
            decodeField(buf) {
                // Read array length directly from buffer
                const length = (buf[0] << 8) | buf[1];
                // Acquire pooled array and resize if needed
                const items = arrayPool.acquire();
                items.length = length;
                // Create or reuse DataView for reading
                if (!decodeView || decodeView.buffer !== buf.buffer || decodeView.byteOffset !== buf.byteOffset) {
                    decodeView = new DataView(buf.buffer, buf.byteOffset);
                }
                // Read each item using pooled objects
                let offset = 2;
                for (let i = 0; i < length; i++) {
                    const item = objectPool.acquire();
                    // Decode directly into pooled object
                    for (const key of Object.keys(itemSchema)) {
                        const field = itemSchema[key];
                        item[key] = field.read(decodeView, offset);
                        offset += field.size;
                    }
                    items[i] = item;
                }
                return { value: items, bytesRead: offset };
            },
            decode(buf) {
                return this.decodeField(buf).value;
            },
            toNil() {
                return [];
            }
        };
    }
}

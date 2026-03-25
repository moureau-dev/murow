/**
 * Internal symbol used to cache computed schema byte size.
 */
const SCHEMA_SIZE = Symbol("schemaSize");
/**
 * Computes and caches the total byte size of a schema.
 * @param schema Binary schema definition
 */
function getSchemaSize(schema) {
    const cached = schema[SCHEMA_SIZE];
    if (cached !== undefined)
        return cached;
    let size = 0;
    for (const k of Object.keys(schema)) {
        size += schema[k].size;
    }
    schema[SCHEMA_SIZE] = size;
    return size;
}
/**
 * Base codec implementation.
 * Handles schema-driven encoding/decoding.
 */
export class BaseBinaryCodec {
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
    static encodeInto(schema, data) {
        const size = getSchemaSize(schema);
        const buffer = new ArrayBuffer(size);
        const view = new DataView(buffer);
        let o = 0;
        for (const k of Object.keys(schema)) {
            const f = schema[k];
            f.write(view, o, data[k]);
            o += f.size;
        }
        return new Uint8Array(buffer);
    }
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
    static decodeInto(schema, buf, target) {
        const expectedSize = getSchemaSize(schema);
        if (buf.byteLength < expectedSize) {
            throw new RangeError(`Buffer too small: expected ${expectedSize} bytes, got ${buf.byteLength}`);
        }
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let o = 0;
        for (const k of Object.keys(schema)) {
            const f = schema[k];
            target[k] = f.read(view, o);
            o += f.size;
        }
        return target;
    }
}
/**
 * Built-in binary primitive field definitions for multiplayer games.
 */
export class BinaryPrimitives {
    /**
     * String field with UTF-8 encoding and 2-byte length prefix.
     * @param maxLength Maximum number of bytes allowed
     */
    static string(maxLength) {
        return {
            size: maxLength + 2,
            write(dv, o, v) {
                const encoder = new TextEncoder();
                const bytes = encoder.encode(v);
                if (bytes.length > maxLength)
                    throw new RangeError(`String too long, max ${maxLength} bytes`);
                dv.setUint16(o, bytes.length, false);
                for (let i = 0; i < bytes.length; i++)
                    dv.setUint8(o + 2 + i, bytes[i]);
                for (let i = bytes.length; i < maxLength; i++)
                    dv.setUint8(o + 2 + i, 0);
            },
            read(dv, o) {
                const length = dv.getUint16(o, false);
                const bytes = new Uint8Array(length);
                for (let i = 0; i < length; i++)
                    bytes[i] = dv.getUint8(o + 2 + i);
                return new TextDecoder().decode(bytes);
            },
            toNil: () => "",
        };
    }
}
/** Unsigned 8-bit integer */
BinaryPrimitives.u8 = {
    size: 1,
    write: (dv, o, v) => dv.setUint8(o, v),
    read: (dv, o) => dv.getUint8(o),
    toNil: () => 0,
};
/** Unsigned 16-bit integer (big-endian) */
BinaryPrimitives.u16 = {
    size: 2,
    write: (dv, o, v) => dv.setUint16(o, v, false),
    read: (dv, o) => dv.getUint16(o, false),
    toNil: () => 0,
};
/** Unsigned 32-bit integer (big-endian) */
BinaryPrimitives.u32 = {
    size: 4,
    write: (dv, o, v) => dv.setUint32(o, v, false),
    read: (dv, o) => dv.getUint32(o, false),
    toNil: () => 0,
};
/** Signed 8-bit integer */
BinaryPrimitives.i8 = {
    size: 1,
    write: (dv, o, v) => dv.setInt8(o, v),
    read: (dv, o) => dv.getInt8(o),
    toNil: () => 0,
};
/** Signed 16-bit integer (big-endian) */
BinaryPrimitives.i16 = {
    size: 2,
    write: (dv, o, v) => dv.setInt16(o, v, false),
    read: (dv, o) => dv.getInt16(o, false),
    toNil: () => 0,
};
/** Signed 32-bit integer (big-endian) */
BinaryPrimitives.i32 = {
    size: 4,
    write: (dv, o, v) => dv.setInt32(o, v, false),
    read: (dv, o) => dv.getInt32(o, false),
    toNil: () => 0,
};
/** 16-bit floating point number (IEEE 754, big-endian) */
BinaryPrimitives.f16 = {
    size: 2,
    write: (dv, o, v) => {
        // Convert f32 to f16
        const floatView = new Float32Array(1);
        const intView = new Uint32Array(floatView.buffer);
        floatView[0] = v;
        const f32 = intView[0];
        // Extract f32 components
        const sign = (f32 >>> 31) & 0x1;
        let exp = (f32 >>> 23) & 0xFF;
        let frac = f32 & 0x7FFFFF;
        // Convert to f16
        let f16bits;
        if (exp === 0xFF) {
            // Infinity or NaN
            f16bits = (sign << 15) | (0x1F << 10) | (frac ? 0x200 : 0);
        }
        else if (exp === 0) {
            // Zero or denormal -> becomes zero in f16
            f16bits = sign << 15;
        }
        else {
            // Normalized number
            const newExp = exp - 127 + 15; // Rebias exponent
            if (newExp >= 0x1F) {
                // Overflow to infinity
                f16bits = (sign << 15) | (0x1F << 10);
            }
            else if (newExp <= 0) {
                // Underflow to zero
                f16bits = sign << 15;
            }
            else {
                // Normal conversion
                const newFrac = frac >>> 13; // Keep top 10 bits
                f16bits = (sign << 15) | (newExp << 10) | newFrac;
            }
        }
        dv.setUint16(o, f16bits, false);
    },
    read: (dv, o) => {
        const f16bits = dv.getUint16(o, false);
        // Extract f16 components
        const sign = (f16bits >>> 15) & 0x1;
        const exp = (f16bits >>> 10) & 0x1F;
        const frac = f16bits & 0x3FF;
        // Convert to f32
        let f32bits;
        if (exp === 0) {
            // Zero or denormal -> becomes zero in f32
            f32bits = sign << 31;
        }
        else if (exp === 0x1F) {
            // Infinity or NaN
            f32bits = (sign << 31) | (0xFF << 23) | (frac ? (frac << 13) : 0);
        }
        else {
            // Normalized number
            const newExp = exp - 15 + 127; // Rebias
            f32bits = (sign << 31) | (newExp << 23) | (frac << 13);
        }
        const intView = new Uint32Array([f32bits]);
        const floatView = new Float32Array(intView.buffer);
        return floatView[0];
    },
    toNil: () => 0,
};
/** 32-bit floating point number (IEEE 754, big-endian) */
BinaryPrimitives.f32 = {
    size: 4,
    write: (dv, o, v) => dv.setFloat32(o, v, false),
    read: (dv, o) => dv.getFloat32(o, false),
    toNil: () => 0,
};
/** 64-bit floating point number (double, big-endian) */
BinaryPrimitives.f64 = {
    size: 8,
    write: (dv, o, v) => dv.setFloat64(o, v, false),
    read: (dv, o) => dv.getFloat64(o, false),
    toNil: () => 0,
};
/** Boolean stored as 1 byte (0 = false, 1 = true) */
BinaryPrimitives.bool = {
    size: 1,
    write: (dv, o, v) => dv.setUint8(o, v ? 1 : 0),
    read: (dv, o) => dv.getUint8(o) !== 0,
    toNil: () => false,
};
/** 2D vector of f32 (x, y) */
BinaryPrimitives.vec2 = {
    size: 8,
    write(dv, o, v) {
        dv.setFloat32(o, v.x, false);
        dv.setFloat32(o + 4, v.y, false);
    },
    read(dv, o) {
        return { x: dv.getFloat32(o, false), y: dv.getFloat32(o + 4, false) };
    },
    toNil: () => ({ x: 0, y: 0 }),
};
/** 3D vector of f32 (x, y, z) */
BinaryPrimitives.vec3 = {
    size: 12,
    write(dv, o, v) {
        dv.setFloat32(o, v.x, false);
        dv.setFloat32(o + 4, v.y, false);
        dv.setFloat32(o + 8, v.z, false);
    },
    read(dv, o) {
        return {
            x: dv.getFloat32(o, false),
            y: dv.getFloat32(o + 4, false),
            z: dv.getFloat32(o + 8, false),
        };
    },
    toNil: () => ({ x: 0, y: 0, z: 0 }),
};
/** RGBA color packed as 4 u8 bytes */
BinaryPrimitives.color = {
    size: 4,
    write(dv, o, v) {
        dv.setUint8(o, v.r);
        dv.setUint8(o + 1, v.g);
        dv.setUint8(o + 2, v.b);
        dv.setUint8(o + 3, v.a);
    },
    read(dv, o) {
        return {
            r: dv.getUint8(o),
            g: dv.getUint8(o + 1),
            b: dv.getUint8(o + 2),
            a: dv.getUint8(o + 3),
        };
    },
    toNil: () => ({ r: 0, g: 0, b: 0, a: 0 }),
};
/** 32-bit floating point number (IEEE 754, little-endian) */
BinaryPrimitives.f32_le = {
    size: 4,
    write: (dv, o, v) => dv.setFloat32(o, v, true),
    read: (dv, o) => dv.getFloat32(o, true),
    toNil: () => 0,
};
/** 64-bit floating point number (double, little-endian) */
BinaryPrimitives.f64_le = {
    size: 8,
    write: (dv, o, v) => dv.setFloat64(o, v, true),
    read: (dv, o) => dv.getFloat64(o, true),
    toNil: () => 0,
};
/** Unsigned 16-bit integer (little-endian) */
BinaryPrimitives.u16_le = {
    size: 2,
    write: (dv, o, v) => dv.setUint16(o, v, true),
    read: (dv, o) => dv.getUint16(o, true),
    toNil: () => 0,
};
/** Unsigned 32-bit integer (little-endian) */
BinaryPrimitives.u32_le = {
    size: 4,
    write: (dv, o, v) => dv.setUint32(o, v, true),
    read: (dv, o) => dv.getUint32(o, true),
    toNil: () => 0,
};
/** Signed 16-bit integer (little-endian) */
BinaryPrimitives.i16_le = {
    size: 2,
    write: (dv, o, v) => dv.setInt16(o, v, true),
    read: (dv, o) => dv.getInt16(o, true),
    toNil: () => 0,
};
/** Signed 32-bit integer (little-endian) */
BinaryPrimitives.i32_le = {
    size: 4,
    write: (dv, o, v) => dv.setInt32(o, v, true),
    read: (dv, o) => dv.getInt32(o, true),
    toNil: () => 0,
};
/**
 * 2D vector of f32 stored as a tuple [x, y] (little-endian).
 * Useful for compact math data or shader-friendly layouts.
 */
BinaryPrimitives.vec2_le = {
    size: 8,
    write: (dv, o, v) => {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
    },
    read: (dv, o) => [
        dv.getFloat32(o, true),
        dv.getFloat32(o + 4, true),
    ],
    toNil: () => [0, 0],
};
/**
 * 3D vector of f32 stored as a tuple [x, y, z] (little-endian).
 * Commonly used for positions, velocities, or directions.
 */
BinaryPrimitives.vec3_le = {
    size: 12,
    write: (dv, o, v) => {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
    },
    read: (dv, o) => [
        dv.getFloat32(o, true),
        dv.getFloat32(o + 4, true),
        dv.getFloat32(o + 8, true),
    ],
    toNil: () => [0, 0, 0],
};
/**
 * 4D vector of f32 stored as a tuple [x, y, z, w] (little-endian).
 * Useful for quaternions, colors in shaders, or homogeneous coordinates.
 */
BinaryPrimitives.vec4_le = {
    size: 16,
    write: (dv, o, v) => {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
        dv.setFloat32(o + 12, v[3], true);
    },
    read: (dv, o) => [
        dv.getFloat32(o, true),
        dv.getFloat32(o + 4, true),
        dv.getFloat32(o + 8, true),
        dv.getFloat32(o + 12, true),
    ],
    toNil: () => [0, 0, 0, 0],
};
/**
 * Public codec API.
 * Re-exports primitives and exposes encode/decode helpers.
 */
export class BinaryCodec extends BaseBinaryCodec {
    /**
     * Encodes an object into a binary buffer.
     */
    static encode(schema, data) {
        return this.encodeInto(schema, data);
    }
    /**
     * Decodes a binary buffer into an existing object.
     */
    static decode(schema, buf, target) {
        return this.decodeInto(schema, buf, target);
    }
}
/** Unsigned 8-bit integer field */
BinaryCodec.u8 = BinaryPrimitives.u8;
/** Unsigned 16-bit integer field */
BinaryCodec.u16 = BinaryPrimitives.u16;
/** Unsigned 32-bit integer field */
BinaryCodec.u32 = BinaryPrimitives.u32;
/** Signed 8-bit integer field */
BinaryCodec.i8 = BinaryPrimitives.i8;
/** Signed 16-bit integer field */
BinaryCodec.i16 = BinaryPrimitives.i16;
/** Signed 32-bit integer field */
BinaryCodec.i32 = BinaryPrimitives.i32;
/** 16-bit floating point field */
BinaryCodec.f16 = BinaryPrimitives.f16;
/** 32-bit floating point field */
BinaryCodec.f32 = BinaryPrimitives.f32;
/** Boolean field */
BinaryCodec.bool = BinaryPrimitives.bool;
/** String field with length prefix */
BinaryCodec.string = BinaryPrimitives.string;
/** 2D vector field */
BinaryCodec.vec2 = BinaryPrimitives.vec2;
/** 3D vector field */
BinaryCodec.vec3 = BinaryPrimitives.vec3;
/** RGBA color field */
BinaryCodec.color = BinaryPrimitives.color;

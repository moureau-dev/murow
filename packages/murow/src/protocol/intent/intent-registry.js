/**
 * Registry for mapping intent kinds to their codecs.
 *
 * Users instantiate this once and register their intent types with
 * PooledCodec instances (from core/pooled-codec).
 *
 * @example
 * ```ts
 * import { IntentRegistry } from './protocol/intent';
 * import { PooledCodec } from './core/pooled-codec';
 * import { BinaryCodec } from './core/binary-codec';
 *
 * const registry = new IntentRegistry();
 *
 * registry.register(1, new PooledCodec({
 *   kind: BinaryCodec.u8,
 *   tick: BinaryCodec.u32,
 *   dx: BinaryCodec.f32,
 *   dy: BinaryCodec.f32,
 * }));
 *
 * // Encode/decode
 * const buf = registry.encode(intent);
 * const decoded = registry.decode(buf);
 * ```
 */
export class IntentRegistry {
    constructor() {
        this.codecs = new Map();
    }
    /**
     * Register a codec for a specific intent kind.
     * Call this once per intent type at startup.
     */
    register(intent) {
        if (this.codecs.has(intent.kind)) {
            throw new Error(`Intent kind ${intent.kind} is already registered`);
        }
        this.codecs.set(intent.kind, intent.codec);
    }
    /**
     * Encode an intent into binary format.
     */
    encode(intent) {
        const codec = this.codecs.get(intent.kind);
        if (!codec) {
            throw new Error(`No codec registered for intent kind ${intent.kind}`);
        }
        return codec.encode(intent);
    }
    /**
     * Decode binary data into an intent.
     * Extracts the kind from the first byte of the buffer.
     */
    decode(buf) {
        if (buf.byteLength === 0) {
            throw new Error('Cannot decode empty buffer');
        }
        // Extract kind from first byte (all intent codecs must encode kind as u8 in first byte)
        const kind = buf[0];
        const codec = this.codecs.get(kind);
        if (!codec) {
            throw new Error(`No codec registered for intent kind ${kind}`);
        }
        return codec.decode(buf);
    }
    /**
     * Decode binary data into an intent when kind is already known.
     * Useful for testing or when kind is transmitted separately.
     * @deprecated Use decode(buf) instead for standard intent decoding
     */
    decodeWithKnownKind(kind, buf) {
        const codec = this.codecs.get(kind);
        if (!codec) {
            throw new Error(`No codec registered for intent kind ${kind}`);
        }
        return codec.decode(buf);
    }
    has(kind) {
        return this.codecs.has(kind);
    }
    unregister(kind) {
        return this.codecs.delete(kind);
    }
    clear() {
        this.codecs.clear();
    }
    getKinds() {
        return Array.from(this.codecs.keys());
    }
}

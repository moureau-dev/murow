import { DefinedIntent } from "./define-intent";
import type { Intent } from "./intent";
/**
 * Generic codec interface (users import from core/pooled-codec)
 */
export interface Codec<T> {
    encode(value: T): Uint8Array;
    decode(buf: Uint8Array): T;
    calculateSize?(value: T): number;
    encodeInto?(value: T, buffer: Uint8Array, offset: number): number;
}
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
export declare class IntentRegistry {
    private codecs;
    /**
     * Register a codec for a specific intent kind.
     * Call this once per intent type at startup.
     */
    register<T extends Intent>(intent: DefinedIntent<T['kind'], T>): void;
    /**
     * Encode an intent into binary format.
     */
    encode<T extends Intent>(intent: T): Uint8Array;
    /**
     * Decode binary data into an intent.
     * Extracts the kind from the first byte of the buffer.
     */
    decode(buf: Uint8Array): Intent;
    /**
     * Decode binary data into an intent when kind is already known.
     * Useful for testing or when kind is transmitted separately.
     * @deprecated Use decode(buf) instead for standard intent decoding
     */
    decodeWithKnownKind(kind: number, buf: Uint8Array): Intent;
    has(kind: number): boolean;
    unregister(kind: number): boolean;
    clear(): void;
    getKinds(): number[];
}

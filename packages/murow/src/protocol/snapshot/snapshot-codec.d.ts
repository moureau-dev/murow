import type { Snapshot } from "./snapshot";
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
 * Codec for encoding/decoding snapshots with binary serialization.
 *
 * Users instantiate this once with a PooledCodec for their state schema.
 *
 * @example
 * ```ts
 * import { SnapshotCodec } from './protocol/snapshot';
 * import { PooledCodec } from './core/pooled-codec';
 * import { BinaryCodec } from './core/binary-codec';
 *
 * interface GameState {
 *   players: Record<number, { x: number; y: number }>;
 * }
 *
 * const snapshotCodec = new SnapshotCodec<GameState>(
 *   new PooledCodec({ players: // schema })
 * );
 *
 * // Encode/decode
 * const buf = snapshotCodec.encode(snapshot);
 * const decoded = snapshotCodec.decode(buf);
 * ```
 */
export declare class SnapshotCodec<T> {
    private updatesCodec;
    /**
     * @param updatesCodec Codec for encoding/decoding the state updates
     */
    constructor(updatesCodec: Codec<Partial<T>>);
    /**
     * Encode a snapshot into binary format.
     * Format: [tick: u32][updates: encoded by updatesCodec]
     *
     * Uses zero-copy path if codec supports calculateSize and encodeInto.
     */
    encode(snapshot: Snapshot<T>): Uint8Array;
    /**
     * Decode binary data into a snapshot.
     */
    decode(buf: Uint8Array): Snapshot<T>;
}

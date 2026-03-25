import type { Snapshot } from "./snapshot";
/**
 * Generic codec interface (users import from core/pooled-codec)
 */
interface Codec<T> {
    encode(value: T): Uint8Array;
    decode(buf: Uint8Array): T;
    calculateSize?(value: T): number;
    encodeInto?(value: T, buffer: Uint8Array, offset: number): number;
}
/**
 * Registry for multiple snapshot types with different update schemas.
 *
 * This allows efficient delta encoding by only sending specific update types
 * instead of encoding all fields (including empty/nil ones).
 *
 * ## Memory Efficiency
 *
 * The encoding path minimizes allocations:
 * 1. PooledCodec acquires a buffer from its pool (reused across calls)
 * 2. PooledCodec writes data directly to the buffer at sequential offsets
 * 3. SnapshotRegistry creates ONE final buffer: [typeId(1) + tick(4) + updatesBytes]
 * 4. Total allocations per encode: 1 pooled buffer + 1 final buffer
 *
 * Buffer Layout:
 * ```
 * ┌─────────┬────────────┬──────────────────┐
 * │ Type ID │    Tick    │  Updates (codec) │
 * │ (u8)    │   (u32)    │   (variable)     │
 * │ 1 byte  │  4 bytes   │    N bytes       │
 * └─────────┴────────────┴──────────────────┘
 * ```
 *
 * @example
 * ```ts
 * import { SnapshotRegistry } from './protocol/snapshot';
 * import { PooledCodec } from './core/pooled-codec';
 * import { BinaryPrimitives } from './core/binary-codec';
 *
 * // Define different update types
 * interface PlayerUpdate {
 *   players: Array<{ entityId: number; x: number; y: number }>;
 * }
 *
 * interface ScoreUpdate {
 *   score: number;
 * }
 *
 * // Create registry
 * const registry = new SnapshotRegistry<PlayerUpdate | ScoreUpdate>();
 *
 * // Register codecs for each update type
 * registry.register('players', new PooledCodec({
 *   players: PooledCodec.array({
 *     entityId: BinaryPrimitives.u32,
 *     x: BinaryPrimitives.f32,
 *     y: BinaryPrimitives.f32,
 *   })
 * }));
 *
 * registry.register('score', new PooledCodec({
 *   score: BinaryPrimitives.u32
 * }));
 *
 * // Server: Encode specific update type
 * const buf = registry.encode('players', {
 *   tick: 100,
 *   updates: { players: [{ entityId: 1, x: 5, y: 10 }] }
 * });
 *
 * // Client: Decode (type is embedded in message)
 * const { type, snapshot } = registry.decode(buf);
 * applySnapshot(state, snapshot);
 * ```
 */
export declare class SnapshotRegistry<T extends Object = {}> {
    private codecs;
    private typeIds;
    private idToType;
    private nextId;
    /**
     * Register a codec for a specific update type.
     * Call this once per update type at startup.
     */
    register<U extends Partial<T>>(type: string, codec: Codec<U>): void;
    /**
     * Encode a snapshot with a specific update type.
     * Format: [typeId: u8][tick: u32][updates: encoded by codec]
     *
     * Zero-copy encoding path:
     * - Calculate total size needed
     * - Allocate ONE final buffer for [typeId + tick + updates]
     * - Write directly into buffer using encodeInto (no intermediate allocations)
     *
     * Falls back to legacy encode() method if codec doesn't support encodeInto.
     */
    encode<U extends Partial<T>>(type: string, snapshot: Snapshot<U>): Uint8Array;
    /**
     * Decode a snapshot and return both the type and the snapshot.
     */
    decode<U extends Partial<T> = Partial<T>>(buf: Uint8Array): {
        type: string;
        snapshot: Snapshot<U>;
    };
    has(type: string): boolean;
    getTypes(): string[];
    /**
     * Release a decoded snapshot's updates object back to the pool.
     * Call this after you're done processing the snapshot to enable object pooling.
     *
     * @param type The snapshot type (same as used in decode)
     * @param updates The updates object to release
     */
    release<U extends Partial<T>>(type: string, updates: U): void;
}
export {};

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
export class SnapshotCodec<T> {
  /**
   * @param updatesCodec Codec for encoding/decoding the state updates
   */
  constructor(private updatesCodec: Codec<Partial<T>>) {}

  /**
   * Encode a snapshot into binary format.
   * Format: [tick: u32][updates: encoded by updatesCodec]
   *
   * Uses zero-copy path if codec supports calculateSize and encodeInto.
   */
  encode(snapshot: Snapshot<T>): Uint8Array {
    // Use zero-copy path if available
    if (this.updatesCodec.calculateSize && this.updatesCodec.encodeInto) {
      const updatesSize = this.updatesCodec.calculateSize(snapshot.updates);
      const buf = new Uint8Array(4 + updatesSize);

      // Encode tick (4 bytes, little-endian)
      new DataView(buf.buffer).setUint32(0, snapshot.tick, true);

      // Write updates directly into buffer (ZERO COPY!)
      this.updatesCodec.encodeInto(snapshot.updates, buf, 4);

      return buf;
    }

    // Fallback to legacy path
    const updatesBytes = this.updatesCodec.encode(snapshot.updates);
    const buf = new Uint8Array(4 + updatesBytes.length);

    new DataView(buf.buffer).setUint32(0, snapshot.tick, true);
    buf.set(updatesBytes, 4);

    return buf;
  }

  /**
   * Decode binary data into a snapshot.
   */
  decode(buf: Uint8Array): Snapshot<T> {
    // Decode tick (first 4 bytes)
    const tick = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);

    // Decode updates (remaining bytes)
    const updatesBytes = buf.subarray(4);
    const updates = this.updatesCodec.decode(updatesBytes);

    return { tick, updates };
  }
}

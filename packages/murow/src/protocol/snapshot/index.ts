/**
 * Snapshot system for server-to-client state updates.
 *
 * Snapshots are delta updates that contain:
 * 1. Server tick number
 * 2. Partial state updates (only what changed)
 *
 * They need to be:
 * 1. Encoded efficiently (binary)
 * 2. Sent over network
 * 3. Decoded on the client
 * 4. Merged into client state
 *
 * @example
 * ```ts
 * import { Snapshot, SnapshotCodec, applySnapshot } from './protocol/snapshot';
 * import { PooledCodec } from '../core/pooled-codec';
 * import { BinaryCodec } from '../core/binary-codec';
 *
 * interface GameState {
 *   players: Record<number, { x: number; y: number }>;
 * }
 *
 * // 1. Create codec once (reuse this instance)
 * const snapshotCodec = new SnapshotCodec<GameState>(
 *   new PooledCodec({ players: // ... your schema })
 * );
 *
 * // 2. Server: Encode snapshot
 * const snapshot: Snapshot<GameState> = {
 *   tick: 100,
 *   updates: { players: { 1: { x: 5, y: 10 } } }
 * };
 * const buf = snapshotCodec.encode(snapshot);
 *
 * // 3. Client: Decode and apply
 * const snapshot = snapshotCodec.decode(buf);
 * applySnapshot(clientState, snapshot);
 * ```
 */

export type { Snapshot } from "./snapshot";
export { applySnapshot } from "./snapshot";
export { SnapshotCodec } from "./snapshot-codec";
export { SnapshotRegistry } from "./snapshot-registry";

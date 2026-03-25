/**
 * RPC (Remote Procedure Call) type definitions
 *
 * RPCs are bidirectional one-off events/commands for:
 * - Meta-game events (achievements, notifications)
 * - Match lifecycle (countdown, results)
 * - Request/response patterns
 * - System announcements
 *
 * NOT for game state synchronization (use Snapshots) or player inputs (use Intents)
 */

/**
 * Codec interface for encoding/decoding RPCs
 */
export interface RpcCodec<T> {
	encode(value: T): Uint8Array;
	decode(buf: Uint8Array): T;
}

/**
 * Runtime RPC message structure
 */
export interface RPC<T = unknown> {
	method: string;
	data: T;
}

/**
 * Compile-time RPC definition with type safety
 * Created by defineRPC() helper
 */
export interface DefinedRPC<TSchema extends Record<string, any>> {
	method: string;
	codec: RpcCodec<TSchema>;
	type: TSchema; // Phantom type for inference
}

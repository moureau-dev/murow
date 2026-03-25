import type { DefinedRPC, RpcCodec } from "./rpc";
import type { Schema } from "../../core/binary-codec";
import { BinaryCodec } from "../../core/binary-codec";

/**
 * Configuration for defining an RPC type.
 * @template S The schema type describing the RPC's data fields
 */
export interface RpcDefinition<S extends Record<string, any>> {
	/** Method name for this RPC (must be unique) */
	method: string;
	/** Schema describing the RPC's data fields */
	schema: S;
}

/**
 * Infers the TypeScript type from an RPC schema.
 * @template S The schema type
 */
export type InferRpcType<S extends Record<string, any>> = {
	[P in keyof S]: S[P] extends { read(dv: DataView, o: number): infer R } ? R : never;
};

/**
 * Simple codec implementation that uses BinaryCodec for encoding/decoding.
 * @template T The RPC data type
 */
class RpcCodecImpl<T extends object> implements RpcCodec<T> {
	constructor(private schema: Schema<T>) {}

	encode(value: T): Uint8Array {
		return BinaryCodec.encode(this.schema, value);
	}

	decode(buf: Uint8Array): T {
		// Create a target object with nil values
		const target = {} as T;
		for (const key of Object.keys(this.schema) as (keyof T)[]) {
			const field = this.schema[key];
			target[key] = field.toNil() as T[keyof T];
		}
		return BinaryCodec.decode(this.schema, buf, target);
	}
}

/**
 * Define a type-safe RPC with automatic schema generation.
 *
 * RPCs are bidirectional one-off events/commands for:
 * - Meta-game events (achievements, notifications)
 * - Match lifecycle (countdown, results)
 * - Request/response patterns
 * - System announcements
 *
 * NOT for game state synchronization (use Snapshots) or player inputs (use Intents)
 *
 * @template S The schema type
 * @param definition RPC configuration with method and schema
 * @returns A DefinedRpc object with method and codec
 *
 * @example Server → Client RPC
 * ```ts
 * const MatchCountdown = defineRPC({
 *   method: 'matchCountdown',
 *   schema: {
 *     secondsRemaining: BinaryCodec.u8,
 *   }
 * });
 *
 * // Server sends
 * server.sendRpcBroadcast(MatchCountdown, { secondsRemaining: 10 });
 *
 * // Client receives
 * client.onRpc(MatchCountdown, (rpc) => {
 *   console.log(`Match starting in ${rpc.secondsRemaining}s`);
 * });
 * ```
 *
 * @example Client → Server RPC
 * ```ts
 * const BuyItem = defineRPC({
 *   method: 'buyItem',
 *   schema: {
 *     itemId: BinaryCodec.string(32),
 *   }
 * });
 *
 * // Client sends
 * client.sendRpc(BuyItem, { itemId: 'long_sword' });
 *
 * // Server receives
 * server.onRpc(BuyItem, (peerId, rpc) => {
 *   console.log(`${peerId} wants to buy ${rpc.itemId}`);
 * });
 * ```
 */
export function defineRPC<S extends Record<string, any>>(
	definition: RpcDefinition<S>
): DefinedRPC<InferRpcType<S>> {
	type RpcType = InferRpcType<S>;

	// Create the schema from definition
	const schema = definition.schema as Schema<RpcType>;

	// Create the codec using BinaryCodec
	const codec = new RpcCodecImpl<RpcType>(schema);

	return {
		method: definition.method,
		codec,
		type: undefined as any as RpcType, // Phantom type for inference
	};
}

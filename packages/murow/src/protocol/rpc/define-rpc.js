import { BinaryCodec } from "../../core/binary-codec";
/**
 * Simple codec implementation that uses BinaryCodec for encoding/decoding.
 * @template T The RPC data type
 */
class RpcCodecImpl {
    constructor(schema) {
        this.schema = schema;
    }
    encode(value) {
        return BinaryCodec.encode(this.schema, value);
    }
    decode(buf) {
        // Create a target object with nil values
        const target = {};
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            target[key] = field.toNil();
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
export function defineRPC(definition) {
    // Create the schema from definition
    const schema = definition.schema;
    // Create the codec using BinaryCodec
    const codec = new RpcCodecImpl(schema);
    return {
        method: definition.method,
        codec,
        type: undefined, // Phantom type for inference
    };
}

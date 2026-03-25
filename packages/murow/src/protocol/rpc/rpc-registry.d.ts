import type { DefinedRPC } from './rpc';
/**
 * Registry for managing RPC definitions with binary encoding/decoding
 *
 * Maps RPC method names to numeric IDs for efficient binary protocol:
 * - Method names are assigned sequential IDs (0, 1, 2, ...)
 * - Binary format: [methodId: u16][data: variable]
 * - Supports bidirectional RPCs (client ↔ server)
 *
 * @example
 * ```ts
 * const registry = new RpcRegistry();
 *
 * // Register RPCs
 * registry.register(MatchCountdown);
 * registry.register(BuyItem);
 *
 * // Encode RPC to binary
 * const binary = registry.encode(MatchCountdown, { secondsRemaining: 10 });
 *
 * // Decode RPC from binary
 * const { method, data } = registry.decode(binary);
 * console.log(method); // 'matchCountdown'
 * console.log(data.secondsRemaining); // 10
 * ```
 */
export declare class RpcRegistry {
    private codecs;
    private methodToId;
    private idToMethod;
    private nextId;
    /**
     * Register an RPC definition
     *
     * @param rpc The RPC definition created by defineRPC()
     * @throws Error if method is already registered
     *
     * @example
     * ```ts
     * const MatchCountdown = defineRPC({
     *   method: 'matchCountdown',
     *   schema: { secondsRemaining: BinaryCodec.u8 }
     * });
     *
     * registry.register(MatchCountdown);
     * ```
     */
    register<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>): void;
    /**
     * Encode an RPC to binary format
     *
     * Binary format: [methodId: u16][data: variable]
     *
     * @param rpc The RPC definition
     * @param data The RPC data to encode
     * @returns Encoded binary data
     * @throws Error if RPC is not registered
     *
     * @example
     * ```ts
     * const binary = registry.encode(MatchCountdown, {
     *   secondsRemaining: 10
     * });
     * ```
     */
    encode<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>, data: TSchema): Uint8Array;
    /**
     * Decode an RPC from binary format
     *
     * @param buffer Binary data to decode
     * @returns Object with method name and decoded data
     * @throws Error if method ID is unknown
     *
     * @example
     * ```ts
     * const { method, data } = registry.decode(binary);
     * console.log(method); // 'matchCountdown'
     * console.log(data.secondsRemaining); // 10
     * ```
     */
    decode(buffer: Uint8Array): {
        method: string;
        data: any;
    };
    /**
     * Check if an RPC method is registered
     *
     * @param method Method name to check
     * @returns True if registered, false otherwise
     */
    has(method: string): boolean;
    /**
     * Get all registered RPC method names
     *
     * @returns Array of method names
     */
    getMethods(): string[];
    /**
     * Get the numeric ID for a method
     *
     * @param method Method name
     * @returns Method ID or undefined if not registered
     */
    getMethodId(method: string): number | undefined;
    /**
     * Release a decoded RPC data object back to the pool.
     * Call this after you're done processing the RPC to enable object pooling.
     *
     * @param method The RPC method name (same as used in decode)
     * @param data The RPC data object to release
     */
    release(method: string, data: any): void;
}

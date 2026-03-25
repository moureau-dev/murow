import type { DefinedRPC, RpcCodec } from './rpc';

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
export class RpcRegistry {
	private codecs = new Map<string, RpcCodec<any>>();
	private methodToId = new Map<string, number>();
	private idToMethod = new Map<number, string>();
	private nextId = 0;

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
	register<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>): void {
		if (this.codecs.has(rpc.method)) {
			throw new Error(`RPC "${rpc.method}" is already registered`);
		}

		const id = this.nextId++;
		this.codecs.set(rpc.method, rpc.codec);
		this.methodToId.set(rpc.method, id);
		this.idToMethod.set(id, rpc.method);
	}

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
	encode<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>, data: TSchema): Uint8Array {
		const codec = this.codecs.get(rpc.method);
		if (!codec) {
			throw new Error(`RPC "${rpc.method}" is not registered`);
		}

		const methodId = this.methodToId.get(rpc.method)!;
		const encodedData = codec.encode(data);

		// Message format: [methodId: u16][data]
		const buffer = new Uint8Array(2 + encodedData.byteLength);
		new DataView(buffer.buffer).setUint16(0, methodId, true);
		buffer.set(new Uint8Array(encodedData), 2);

		return buffer;
	}

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
	decode(buffer: Uint8Array): { method: string; data: any } {
		if (buffer.byteLength < 2) {
			throw new Error('Buffer too small for RPC message');
		}

		const view = new DataView(buffer.buffer, buffer.byteOffset);
		const methodId = view.getUint16(0, true);

		const method = this.idToMethod.get(methodId);
		if (!method) {
			throw new Error(`Unknown RPC method ID: ${methodId}`);
		}

		const codec = this.codecs.get(method)!;
		const data = codec.decode(buffer.slice(2));

		return { method, data };
	}

	/**
	 * Check if an RPC method is registered
	 *
	 * @param method Method name to check
	 * @returns True if registered, false otherwise
	 */
	has(method: string): boolean {
		return this.codecs.has(method);
	}

	/**
	 * Get all registered RPC method names
	 *
	 * @returns Array of method names
	 */
	getMethods(): string[] {
		return Array.from(this.codecs.keys());
	}

	/**
	 * Get the numeric ID for a method
	 *
	 * @param method Method name
	 * @returns Method ID or undefined if not registered
	 */
	getMethodId(method: string): number | undefined {
		return this.methodToId.get(method);
	}

	/**
	 * Release a decoded RPC data object back to the pool.
	 * Call this after you're done processing the RPC to enable object pooling.
	 *
	 * @param method The RPC method name (same as used in decode)
	 * @param data The RPC data object to release
	 */
	release(method: string, data: any): void {
		const codec = this.codecs.get(method);

		if (!codec) {
			throw new Error(`RPC "${method}" is not registered`);
		}

		// Only release if the codec supports pooling
		if ('release' in codec && typeof codec.release === 'function') {
			codec.release(data);
		}
	}
}

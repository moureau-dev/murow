import { ObjectPool } from "../core/pooled-codec/pooled-codec";

/**
 * Message wrapper pool for network messages
 * Pools buffers for wrapping encoded data with message type headers
 *
 * Works alongside PooledCodec:
 * - PooledCodec handles encoding game data (intents/snapshots)
 * - MessageWrapperPool handles wrapping with protocol headers
 *
 * This eliminates the "new Uint8Array(1 + data.length)" allocation in hot paths
 *
 * Uses ObjectPool from core/pooled-codec for consistent pooling strategy
 */
export class MessageWrapperPool {
	private pools: Map<number, ObjectPool<Uint8Array>> = new Map();
	private readonly sizeClass: number;
	private readonly zeroBuffersOnRelease: boolean;

	/**
	 * @param sizeClass Buffers are pooled in multiples of this size (default: 256 bytes)
	 * @param zeroBuffersOnRelease If true, zero buffers before returning to pool (default: false for performance)
	 */
	constructor(sizeClass: number = 256, zeroBuffersOnRelease: boolean = false) {
		this.sizeClass = sizeClass;
		this.zeroBuffersOnRelease = zeroBuffersOnRelease;
	}

	/**
	 * Wrap payload data with a message type header
	 * Returns a buffer from the pool (or allocates if needed)
	 *
	 * Format: [messageType: u8][payload: Uint8Array]
	 *
	 * IMPORTANT: Caller must call release() when done to return buffer to pool
	 */
	wrap(messageType: number, payload: Uint8Array): Uint8Array {
		const totalSize = 1 + payload.byteLength;
		const poolSize = Math.ceil(totalSize / this.sizeClass) * this.sizeClass;

		// Get or create pool for this size class
		let pool = this.pools.get(poolSize);
		if (!pool) {
			pool = new ObjectPool(() => new Uint8Array(poolSize));
			this.pools.set(poolSize, pool);
		}

		// Acquire buffer from pool
		const buffer = pool.acquire();

		// Write message type and payload
		buffer[0] = messageType;
		buffer.set(payload, 1);

		// Return view of exact size needed
		return buffer.subarray(0, totalSize);
	}

	/**
	 * Return a buffer to the pool for reuse
	 * Optionally zeros buffer based on constructor config
	 *
	 * WARNING: Caller must not use the buffer after calling release()
	 */
	release(buffer: Uint8Array): void {
		// Get the actual underlying buffer size
		const poolSize = buffer.buffer.byteLength;

		// Only pool buffers that match our size classes
		if (poolSize % this.sizeClass !== 0) {
			return;
		}

		const pool = this.pools.get(poolSize);
		if (!pool) {
			return; // No pool for this size, let it be garbage collected
		}

		// Create a view of the full buffer
		const fullBuffer = new Uint8Array(buffer.buffer);

		// Optionally zero buffer (expensive but safer if caller might hold references)
		if (this.zeroBuffersOnRelease) {
			fullBuffer.fill(0);
		}

		pool.release(fullBuffer);
	}

	/**
	 * Get current pool statistics
	 * Note: ObjectPool doesn't expose size, so we can only list pool classes
	 */
	getStats(): { poolSizes: number[] } {
		return {
			poolSizes: Array.from(this.pools.keys()).sort((a, b) => a - b),
		};
	}

	/**
	 * Clear all pooled buffers (useful for testing or memory cleanup)
	 */
	clear(): void {
		this.pools.clear();
	}
}

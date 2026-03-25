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
export declare class MessageWrapperPool {
    private pools;
    private readonly sizeClass;
    private readonly zeroBuffersOnRelease;
    /**
     * @param sizeClass Buffers are pooled in multiples of this size (default: 256 bytes)
     * @param zeroBuffersOnRelease If true, zero buffers before returning to pool (default: false for performance)
     */
    constructor(sizeClass?: number, zeroBuffersOnRelease?: boolean);
    /**
     * Wrap payload data with a message type header
     * Returns a buffer from the pool (or allocates if needed)
     *
     * Format: [messageType: u8][payload: Uint8Array]
     *
     * IMPORTANT: Caller must call release() when done to return buffer to pool
     */
    wrap(messageType: number, payload: Uint8Array): Uint8Array;
    /**
     * Return a buffer to the pool for reuse
     * Optionally zeros buffer based on constructor config
     *
     * WARNING: Caller must not use the buffer after calling release()
     */
    release(buffer: Uint8Array): void;
    /**
     * Get current pool statistics
     * Note: ObjectPool doesn't expose size, so we can only list pool classes
     */
    getStats(): {
        poolSizes: number[];
    };
    /**
     * Clear all pooled buffers (useful for testing or memory cleanup)
     */
    clear(): void;
}

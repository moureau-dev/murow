/**
 * Core networking types for transport-agnostic multiplayer game networking
 */

/**
 * Generic transport adapter interface - implement this to support any transport layer
 * (WebSocket, WebRTC, UDP, Socket.io, etc.)
 *
 * IMPORTANT: Implementations MUST copy the data buffer if they need to hold a reference
 * after send() returns. The caller may reuse/mutate the buffer immediately after send()
 * completes (for buffer pooling optimization).
 */
export interface TransportAdapter {
	/**
	 * Send binary data through the transport.
	 *
	 * CRITICAL: You MUST copy the buffer if your transport will access it after
	 * this method returns (e.g., in async operations, queues, or callbacks).
	 * The caller may reuse this buffer immediately after send() completes.
	 *
	 * WebSocket transports (Bun, browser) copy automatically and are safe.
	 * Custom transports MUST explicitly copy: `new Uint8Array(data)`
	 */
	send(data: Uint8Array): void | Promise<void>;

	/**
	 * Register a callback for connection open
	 */
	onOpen?(handler: () => void): void;

	/**
	 * Register a callback for incoming binary data
	 */
	onMessage(handler: (data: Uint8Array) => void): void;

	/**
	 * Register a callback for connection close/disconnect
	 */
	onClose(handler: () => void): void;

	/**
	 * Register a callback for transport errors (optional)
	 */
	onError?(handler: (error: Error) => void): void;

	/**
	 * Close the connection
	 */
	close(): void | Promise<void>;
}

/**
 * Server-side transport adapter - manages multiple peer connections
 */
export interface ServerTransportAdapter<TPeer extends TransportAdapter> {
	/**
	 * Register a callback for new peer connections
	 */
	onConnection(handler: (peer: TPeer, peerId: string) => void): void;

	/**
	 * Register a callback for peer disconnections
	 */
	onDisconnection(handler: (peerId: string) => void): void;

	/**
	 * Get a specific peer connection by ID
	 */
	getPeer(peerId: string): TPeer | undefined;

	/**
	 * Get all connected peer IDs
	 */
	getPeerIds(): string[];

	/**
	 * Close the server and all connections
	 */
	close(): void | Promise<void>;
}

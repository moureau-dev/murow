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

/**
 * Message type identifiers for protocol discrimination
 */
export enum MessageType {
	/** Client -> Server: Intent/command */
	INTENT = 0x01,
	/** Server -> Client: State snapshot */
	SNAPSHOT = 0x02,
	/** Bidirectional: Heartbeat/ping */
	HEARTBEAT = 0x03,
	/** Bidirectional: Custom application message */
	CUSTOM = 0xff,
}

/**
 * Message priority levels for send queue
 */
export enum MessagePriority {
	/** Lowest priority - can be dropped if queue is full (e.g., chat) */
	LOW = 0,
	/** Normal priority - most game messages (e.g., movement) */
	NORMAL = 1,
	/** High priority - important events (e.g., damage, scoring) */
	HIGH = 2,
	/** Critical priority - never drop (e.g., connection control) */
	CRITICAL = 3,
}

/**
 * Queued message with priority
 */
export interface QueuedMessage {
	data: Uint8Array;
	priority: MessagePriority;
	timestamp: number;
}

/**
 * Lag simulation configuration for testing network conditions
 */
export type LagSimulation = number | { min: number; max: number };

/**
 * Configuration for network message handling
 */
export interface NetworkConfig {
	/**
	 * Maximum message size in bytes (default: 64KB)
	 */
	maxMessageSize?: number;

	/**
	 * Enable debug logging
	 */
	debug?: boolean;

	/**
	 * Maximum messages per second per peer (server only, default: 100)
	 * Set to 0 to disable rate limiting
	 */
	maxMessagesPerSecond?: number;

	/**
	 * Maximum send queue size per peer (default: 100)
	 * When exceeded, oldest messages are dropped
	 */
	maxSendQueueSize?: number;

	/**
	 * Enable buffer pooling for message wrapping (default: true)
	 *
	 * IMPORTANT: Only enable if your transport copies buffers synchronously in send().
	 * WebSocket transports (Bun, browser) are safe. Custom transports that queue
	 * buffers internally MUST copy the buffer before queuing.
	 */
	enableBufferPooling?: boolean;

	/**
	 * Heartbeat interval in milliseconds (default: 30000 = 30s)
	 * Set to 0 to disable heartbeats
	 */
	heartbeatInterval?: number;

	/**
	 * Heartbeat timeout in milliseconds (default: 60000 = 60s)
	 * If no message received within this time, connection is considered dead
	 */
	heartbeatTimeout?: number;

	/**
	 * Simulate network lag for testing (client-side only)
	 * - number: Fixed delay in milliseconds
	 * - {min, max}: Random delay between min and max milliseconds
	 * - undefined: No lag simulation (default)
	 *
	 * @example
	 * ```ts
	 * // Fixed 100ms lag
	 * lagSimulation: 100
	 *
	 * // Random lag between 50-150ms
	 * lagSimulation: { min: 50, max: 150 }
	 * ```
	 */
	lagSimulation?: LagSimulation;
}

/**
 * Per-peer state tracking on the server
 */
export interface PeerState {
	/** Unique peer identifier */
	peerId: string;

	/** Transport connection for this peer */
	transport: TransportAdapter;

	/** Last tick number sent to this peer */
	lastSentTick: number;

	/** Connection timestamp */
	connectedAt: number;

	/** Custom metadata (e.g., player name, team, etc.) */
	metadata: Record<string, unknown>;

	/** Rate limiting: message count in current second */
	messageCount: number;

	/** Rate limiting: timestamp of current second window */
	messageCountWindow: number;

	/** Send queue for backpressure handling (prioritized) */
	sendQueue: QueuedMessage[];

	/** Bandwidth tracking: bytes sent in current second */
	bytesSent: number;

	/** Bandwidth tracking: timestamp of current second window */
	bandwidthWindow: number;

	/** Flag to indicate if peer is experiencing backpressure */
	isBackpressured: boolean;

	/** Last time we received any message from this peer */
	lastMessageReceivedAt: number;
}

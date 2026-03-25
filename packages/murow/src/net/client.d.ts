import type { IntentRegistry } from "../protocol/intent/intent-registry";
import type { SnapshotRegistry } from "../protocol/snapshot/snapshot-registry";
import type { Snapshot } from "../protocol/snapshot/snapshot";
import type { Intent } from "../protocol/intent/intent";
import type { RpcRegistry } from "../protocol/rpc/rpc-registry";
import type { DefinedRPC } from "../protocol/rpc/rpc";
import { type TransportAdapter, type NetworkConfig } from "./types";
/**
 * Configuration for ClientNetwork
 */
export interface ClientNetworkConfig<TSnapshots> {
    /** Transport adapter for server connection */
    transport: TransportAdapter;
    /** Intent registry for encoding client intents */
    intentRegistry: IntentRegistry;
    /** Snapshot registry for decoding server snapshots */
    snapshotRegistry: SnapshotRegistry<TSnapshots>;
    /** RPC registry for bidirectional remote procedure calls (optional) */
    rpcRegistry?: RpcRegistry;
    /** Network configuration */
    config?: NetworkConfig;
}
/**
 * Generic game client for multiplayer networking
 * Handles intent sending and snapshot receiving with full type safety
 *
 * @template TSnapshots Union type of all possible snapshot update types
 *
 * @example
 * ```ts
 * type GameSnapshots = PlayerUpdate | ScoreUpdate | ProjectileUpdate;
 *
 * const client = new ClientNetwork<GameSnapshots>({
 *   transport: wsTransport,
 *   intentRegistry,
 *   snapshotRegistry,
 * });
 *
 * // Type-safe snapshot handlers
 * client.onSnapshot<PlayerUpdate>('players', (snapshot) => {
 *   snapshot.updates.players // ✅ Correctly typed
 * });
 * ```
 */
export declare class ClientNetwork<TSnapshots = unknown> {
    private transport;
    private intentRegistry;
    private snapshotRegistry;
    private rpcRegistry?;
    private config;
    /** Snapshot type handlers: type -> handler[] (supports multiple handlers) */
    private snapshotHandlers;
    /** RPC method handlers: method -> handler[] (supports multiple handlers) */
    private rpcHandlers;
    /** Connection lifecycle handlers */
    private connectHandlers;
    private disconnectHandlers;
    private errorHandlers;
    /** Connection state */
    private connected;
    /** Last sent intent per kind (for change detection) */
    private lastSentIntents;
    /** Rate limiting state */
    private messageCount;
    private messageCountWindow;
    /** Heartbeat timer */
    private heartbeatTimer;
    /** Last time we received a message from server */
    private lastMessageReceivedAt;
    /** Lag simulation configuration */
    private lagSimulation?;
    constructor(config: ClientNetworkConfig<TSnapshots>);
    /**
     * Send an intent to the server (type-safe)
     */
    /**
     * Check if an intent has changed compared to the last sent intent of the same kind.
     * Useful for bandwidth optimization - only send intents when they actually change.
     *
     * @param intent The intent to check
     * @param compareFn Optional custom comparison function. If not provided, uses JSON.stringify.
     * @returns true if the intent is different from the last sent intent of this kind
     *
     * @example
     * ```ts
     * const moveIntent = { kind: IntentKind.Move, tick: 100, dx: 1, dy: 0 };
     *
     * // Only send if input changed
     * if (client.hasIntentChanged(moveIntent)) {
     *   client.sendIntent(moveIntent);
     * }
     *
     * // Custom comparison (more efficient than JSON.stringify)
     * if (client.hasIntentChanged(moveIntent, (last, current) =>
     *   last.dx !== current.dx || last.dy !== current.dy
     * )) {
     *   client.sendIntent(moveIntent);
     * }
     * ```
     */
    hasIntentChanged<T extends Intent>(intent: T, compareFn?: (last: T, current: T) => boolean): boolean;
    sendIntent<T extends Intent>(intent: T): void;
    /**
     * Register a handler for a specific snapshot type (type-safe)
     * Supports multiple handlers per snapshot type
     * @template T The specific snapshot update type for this handler
     * @returns Unsubscribe function to remove this handler
     */
    onSnapshot<T extends Partial<TSnapshots>>(type: string, handler: (snapshot: Snapshot<T>) => void): () => void;
    /**
     * Send an RPC to the server (type-safe)
     *
     * @template TSchema The RPC data type
     * @param rpc The RPC definition created by defineRPC()
     * @param data The RPC data to send
     *
     * @example
     * ```ts
     * const BuyItem = defineRPC({
     *   method: 'buyItem',
     *   schema: { itemId: BinaryCodec.string(32) }
     * });
     *
     * client.sendRpc(BuyItem, { itemId: 'long_sword' });
     * ```
     */
    sendRPC<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>, data: TSchema): void;
    /**
     * Register a handler for incoming RPCs from the server (type-safe)
     * Supports multiple handlers per RPC method
     *
     * @template TSchema The RPC data type
     * @param rpc The RPC definition created by defineRPC()
     * @param handler Callback function to handle the RPC
     * @returns Unsubscribe function to remove this handler
     *
     * @example
     * ```ts
     * const MatchCountdown = defineRPC({
     *   method: 'matchCountdown',
     *   schema: { secondsRemaining: BinaryCodec.u8 }
     * });
     *
     * client.onRpc(MatchCountdown, (rpc) => {
     *   console.log(`Match starting in ${rpc.secondsRemaining}s`);
     * });
     * ```
     */
    onRPC<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>, handler: (data: TSchema) => void): () => void;
    /**
     * Register a handler for connection events
     */
    onConnect(handler: () => void): () => void;
    /**
     * Register a handler for disconnection events
     */
    onDisconnect(handler: () => void): () => void;
    /**
     * Register a handler for transport errors
     */
    onError(handler: (error: Error) => void): () => void;
    /**
     * Check if connected to server
     */
    isConnected(): boolean;
    /**
     * Disconnect from server
     */
    disconnect(): void | Promise<void>;
    /**
     * Setup transport event handlers
     */
    private setupTransportHandlers;
    /**
     * Setup heartbeat mechanism
     */
    private setupHeartbeat;
    /**
     * Check server heartbeat timeout and send heartbeat
     */
    private checkHeartbeat;
    /**
     * Handle incoming message from server
     */
    private handleMessage;
    /**
     * Decode and handle a snapshot from server
     *
     * IMPORTANT: Handlers receive the pooled object directly (zero-copy).
     * Handlers MUST extract any data they need immediately - do NOT store references to the snapshot.updates object.
     * The object will be released back to the pool after all handlers complete.
     */
    private handleSnapshot;
    /**
     * Handle incoming RPC message from server
     *
     * IMPORTANT: Handlers receive the pooled object directly (zero-copy).
     * Handlers MUST extract any data they need immediately - do NOT store references to the RPC data object.
     * The object will be released back to the pool after all handlers complete.
     */
    private handleRPC;
    /**
     * Handle disconnection from server
     */
    private handleDisconnection;
    /**
     * Notify connect handlers
     */
    private notifyConnectHandlers;
    /**
     * Notify disconnect handlers
     */
    private notifyDisconnectHandlers;
    /**
     * Handle transport errors
     */
    private handleError;
    /**
     * Notify error handlers
     */
    private notifyErrorHandlers;
    /**
     * Check client-side rate limit
     * Returns true if message should be sent, false if rate limit exceeded
     */
    private checkRateLimit;
    /**
     * Calculate lag delay based on lag simulation configuration
     */
    private getLagDelay;
    /**
     * Debug logging
     */
    private log;
}

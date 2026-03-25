import type { IntentRegistry } from "../protocol/intent/intent-registry";
import type { SnapshotRegistry } from "../protocol/snapshot/snapshot-registry";
import type { Snapshot } from "../protocol/snapshot/snapshot";
import type { Intent } from "../protocol/intent/intent";
import type { RpcRegistry } from "../protocol/rpc/rpc-registry";
import type { DefinedRPC } from "../protocol/rpc/rpc";
import { MessagePriority, type PeerState, type ServerTransportAdapter, type TransportAdapter, type NetworkConfig } from "./types";
import { DefinedIntent } from "../protocol";
/**
 * Configuration for ServerNetwork
 */
export interface ServerNetworkConfig<TPeer extends TransportAdapter, TSnapshots> {
    /** Transport adapter for managing peer connections */
    transport: ServerTransportAdapter<TPeer>;
    /** Intent registry for decoding client messages */
    intentRegistry: IntentRegistry;
    /** Factory to create per-peer snapshot registries */
    createPeerSnapshotRegistry: () => SnapshotRegistry<TSnapshots>;
    /** RPC registry for bidirectional remote procedure calls (optional) */
    rpcRegistry?: RpcRegistry;
    /** Network configuration */
    config?: NetworkConfig;
}
/**
 * Generic game server that manages multiple peer connections
 * Each peer gets its own snapshot registry for per-peer state tracking (fog of war, interest management)
 *
 * @template TPeer The transport adapter type for peer connections
 * @template TSnapshots Union type of all possible snapshot update types
 *
 * @remarks
 * **Client-Side Prediction Support:**
 * - Tracks the last VALIDATED client tick for each peer (only intents passing validation update this)
 * - All intents include a 'tick' field (added by defineIntent())
 * - Use validators in `onIntent()` to reject stale/invalid intents - rejected intents don't update the confirmed tick
 * - Use `getConfirmedClientTick(peerId)` to get the confirmed tick for snapshots
 * - Use `onAnyIntent()` to track which peers need snapshot responses
 *
 * @example
 * ```ts
 * type GameSnapshots = PlayerUpdate | ScoreUpdate | ProjectileUpdate;
 *
 * const server = new ServerNetwork<WebSocketPeer, GameSnapshots>({
 *   transport: wsServerTransport,
 *   intentRegistry,
 *   createPeerSnapshotRegistry: () => {
 *     const registry = new SnapshotRegistry<GameSnapshots>();
 *     registry.register('players', playerCodec);
 *     registry.register('score', scoreCodec);
 *     return registry;
 *   },
 * });
 *
 * // Track which peers need responses (fires for ALL intents)
 * const pendingResponses = new Set<string>();
 * server.onAnyIntent((peerId) => {
 *   pendingResponses.add(peerId);
 * });
 *
 * // Type-safe intent handlers with validation (prevents stale intents from updating confirmed tick)
 * // The validator can use getConfirmedClientTick to reject out-of-order intents
 * server.onIntent(Intents.Move, (peerId, intent) => {
 *   // Process the intent
 *   applyMovement(peerId, intent);
 * }, (peerId, intent) => {
 *   // Validator: reject out-of-order intents using the network layer's tracking
 *   const lastTick = server.getConfirmedClientTick(peerId, intent.kind);
 *   if (intent.tick <= lastTick) return false; // Rejected - confirmed tick NOT updated
 *   return true; // Accepted - confirmed tick WILL be updated
 * });
 *
 * // Send snapshot with confirmed client tick for the relevant intent type (for client-side prediction)
 * const confirmedTick = server.getConfirmedClientTick(peerId, Intents.Move.kind);
 * server.sendSnapshotToPeer(peerId, 'players', {
 *   tick: confirmedTick, // Client can reconcile based on this
 *   updates: { players: [...] }
 * });
 * ```
 */
export declare class ServerNetwork<TPeer extends TransportAdapter = TransportAdapter, TSnapshots = unknown> {
    private transport;
    private intentRegistry;
    private createPeerSnapshotRegistry;
    private rpcRegistry?;
    private config;
    /** Per-peer state tracking */
    private peers;
    /** Per-peer snapshot registries - this is the key feature! */
    private peerSnapshotRegistries;
    /** Track last processed client tick per peer per intent kind (for client-side prediction) */
    private lastProcessedClientTick;
    /** Track last sent snapshot hashes per peer per type (for delta detection) */
    private lastSnapshotHashes;
    /** Intent handlers: kind -> handler[] (supports multiple handlers) */
    private intentHandlers;
    /** Global intent handler called for ALL intents before specific handlers */
    private anyIntentHandlers;
    /** RPC method handlers: method -> handler[] (supports multiple handlers) */
    private rpcHandlers;
    /** Connection lifecycle handlers */
    private connectionHandlers;
    private disconnectionHandlers;
    /** Message wrapper pool for zero-allocation message wrapping */
    private messagePool;
    /** Heartbeat interval timer */
    private heartbeatTimer;
    constructor(config: ServerNetworkConfig<TPeer, TSnapshots>);
    /**
     * Get the snapshot registry for a specific peer
     */
    getPeerSnapshotRegistry(peerId: string): SnapshotRegistry<TSnapshots> | undefined;
    /**
     * Register a handler for a specific intent kind (type-safe)
     * Supports multiple handlers per intent type
     * @template T The intent type for this handler
     * @param intent The intent definition
     * @param handler Callback invoked for valid intents
     * @param validator Optional validation function - if it returns false, intent is rejected and lastProcessedClientTick is NOT updated
     * @returns Unsubscribe function to remove this handler
     *
     * @remarks
     * **Important:** The validator controls tick confirmation for client-side prediction.
     * - If validator returns `true`: intent is processed AND lastProcessedClientTick is updated
     * - If validator returns `false`: intent is rejected AND lastProcessedClientTick is NOT updated
     *
     * This ensures only valid, non-stale intents update the confirmed client tick used for reconciliation.
     */
    onIntent<T extends Intent>(intent: DefinedIntent<T['kind'], T>, handler: (peerId: string, intent: T) => void, validator?: (peerId: string, intent: T) => boolean): () => void;
    /**
     * Register a handler that fires for ALL intents, regardless of kind.
     * Useful for tracking which peers sent intents this tick.
     *
     * @param handler Callback invoked for every intent before specific handlers
     * @returns Unsubscribe function
     *
     * @remarks
     * This handler is called BEFORE the specific intent handlers registered via onIntent().
     * Common use case: Track which peers need snapshot responses this tick.
     *
     * @example
     * ```ts
     * const pendingResponses = new Set<string>();
     *
     * server.onAnyIntent((peerId, intent) => {
     *   // Mark this peer as needing a response on next tick
     *   pendingResponses.add(peerId);
     * });
     * ```
     */
    onAnyIntent(handler: (peerId: string, intent: Intent) => void): () => void;
    /**
     * Register a handler for new connections
     */
    onConnection(handler: (peerId: string) => void): void;
    /**
     * Register a handler for disconnections
     */
    onDisconnection(handler: (peerId: string) => void): void;
    /**
     * Send an RPC to a specific peer (type-safe)
     *
     * @template TSchema The RPC data type
     * @param peerId The peer to send to
     * @param rpc The RPC definition created by defineRPC()
     * @param data The RPC data to send
     * @param priority Message priority (default: NORMAL)
     *
     * @example
     * ```ts
     * const MatchCountdown = defineRPC({
     *   method: 'matchCountdown',
     *   schema: { secondsRemaining: BinaryCodec.u8 }
     * });
     *
     * server.sendRpc(peerId, MatchCountdown, { secondsRemaining: 10 });
     * ```
     */
    sendRPC<TSchema extends Record<string, any>>(peerId: string, rpc: DefinedRPC<TSchema>, data: TSchema, priority?: MessagePriority): void;
    /**
     * Send an RPC to all connected peers (broadcast)
     *
     * @template TSchema The RPC data type
     * @param rpc The RPC definition created by defineRPC()
     * @param data The RPC data to send
     * @param priority Message priority (default: NORMAL)
     *
     * @example
     * ```ts
     * server.sendRpcBroadcast(MatchCountdown, { secondsRemaining: 3 });
     * ```
     */
    sendRpcBroadcast<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>, data: TSchema, priority?: MessagePriority): void;
    /**
     * Register a handler for incoming RPCs from clients (type-safe)
     * Supports multiple handlers per RPC method
     *
     * @template TSchema The RPC data type
     * @param rpc The RPC definition created by defineRPC()
     * @param handler Callback function to handle the RPC
     * @returns Unsubscribe function to remove this handler
     *
     * @example
     * ```ts
     * const BuyItem = defineRPC({
     *   method: 'buyItem',
     *   schema: { itemId: BinaryCodec.string(32) }
     * });
     *
     * server.onRpc(BuyItem, (peerId, rpc) => {
     *   console.log(`${peerId} wants to buy ${rpc.itemId}`);
     * });
     * ```
     */
    onRPC<TSchema extends Record<string, any>>(rpc: DefinedRPC<TSchema>, handler: (peerId: string, data: TSchema) => void): () => void;
    /**
     * Send a snapshot to a specific peer using their dedicated snapshot registry (type-safe)
     * @template T The specific snapshot update type
     * @param priority Message priority (default: NORMAL)
     */
    sendSnapshotToPeer<T extends Partial<TSnapshots>>(peerId: string, type: string, snapshot: Snapshot<T>, priority?: MessagePriority): void;
    /**
     * Send a snapshot to a peer only if it has changed since the last send.
     * Uses fast binary hash comparison with zero allocations.
     *
     * @template T The specific snapshot update type
     * @param peerId The peer to send to
     * @param type The snapshot type identifier
     * @param snapshot The snapshot to send
     * @param priority Message priority (default: NORMAL)
     * @returns true if snapshot was sent, false if skipped (no change)
     *
     * @remarks
     * This method encodes the snapshot and computes a hash of the binary data.
     * This is more efficient than JSON.stringify because:
     * 1. No string allocations (hash is a number)
     * 2. Binary hashing is faster than string hashing
     * 3. Reuses the encoding work (binary data needed for sending anyway)
     *
     * @example
     * ```ts
     * // In your game tick loop
     * for (const peerId of server.getPeerIds()) {
     *   const wasSent = server.sendSnapshotToPeerIfChanged(peerId, 'gameState', {
     *     tick: currentTick,
     *     updates: gameState
     *   });
     *   if (wasSent) sentCount++;
     * }
     * ```
     */
    sendSnapshotToPeerIfChanged<T extends Partial<TSnapshots>>(peerId: string, type: string, snapshot: Snapshot<T>, priority?: MessagePriority): boolean;
    /**
     * Fast binary hash function with zero allocations.
     * Uses FNV-1a algorithm optimized for binary data.
     *
     * @param data The binary data to hash
     * @returns A 32-bit hash value
     *
     * @remarks
     * This is significantly faster than JSON.stringify + string hashing because:
     * - No string allocations
     * - Direct byte-level hashing
     * - Operates on data that's already needed for encoding
     *
     * FNV-1a is chosen for its speed and good distribution properties.
     */
    private hashBinary;
    /**
     * Queue a message with priority
     */
    private queueMessage;
    /**
     * Internal: Send a message to a peer, handling pooling and bandwidth tracking
     */
    private sendMessageToPeer;
    /**
     * Flush send queue for a peer (called after successful sends)
     * Sends messages in priority order (highest priority first)
     */
    private flushSendQueue;
    /**
     * Track bandwidth usage for a peer
     */
    private trackBandwidth;
    /**
     * Broadcast a snapshot to all connected peers (type-safe)
     * Each peer receives the snapshot encoded with their own snapshot registry
     * @template T The specific snapshot update type
     * @param priority Message priority (default: NORMAL)
     */
    broadcastSnapshot<T extends Partial<TSnapshots>>(type: string, snapshot: Snapshot<T>, filter?: (peerId: string) => boolean, priority?: MessagePriority): void;
    /**
     * Advanced: Broadcast with per-peer snapshot customization (type-safe)
     * Allows you to modify the snapshot for each peer (e.g., fog of war, interest management)
     * @template T The specific snapshot update type
     * @param priority Message priority (default: NORMAL)
     */
    broadcastSnapshotWithCustomization<T extends Partial<TSnapshots>>(type: string, baseSnapshot: Snapshot<T>, customize: (peerId: string, snapshot: Snapshot<T>) => Snapshot<T>, priority?: MessagePriority): void;
    /**
     * Get all connected peer IDs
     */
    getPeerIds(): string[];
    /**
     * Get peer state for a specific peer
     */
    getPeerState(peerId: string): PeerState | undefined;
    /**
     * Update peer metadata
     */
    setPeerMetadata(peerId: string, key: string, value: unknown): void;
    /**
     * Get bandwidth usage for a peer (bytes per second in current window)
     */
    getPeerBandwidth(peerId: string): number;
    /**
     * Get total bandwidth usage across all peers
     */
    getTotalBandwidth(): number;
    /**
     * Check if a peer is experiencing backpressure
     */
    isPeerBackpressured(peerId: string): boolean;
    /**
     * Get the last confirmed (validated) client tick for a peer and intent kind.
     * Used for client-side prediction reconciliation.
     *
     * @param peerId The peer ID to query
     * @param intentKind The intent kind to query (different intent types have independent tick sequences)
     * @returns The last validated client tick number for this intent kind, or 0 if not found
     *
     * @remarks
     * This is automatically tracked when intents pass validation.
     * Only intents that pass the validator (if provided to onIntent) will update this value.
     * Each intent kind has its own tick sequence, allowing different types of intents
     * (e.g., Move, Shoot, Chat) to have independent tick tracking.
     */
    getConfirmedClientTick(peerId: string, intentKind: number): number;
    /**
     * Set the confirmed client tick for a peer and intent kind.
     * Rarely needed as this is automatically tracked when intents pass validation.
     *
     * @param peerId The peer ID
     * @param intentKind The intent kind
     * @param tick The client tick number to set
     *
     * @remarks
     * This is automatically updated when intents pass validation in onIntent handlers.
     * Manual use of this method is rarely needed.
     */
    setConfirmedClientTick(peerId: string, intentKind: number, tick: number): void;
    /**
     * Close the server and all connections
     */
    close(): void | Promise<void>;
    /**
     * Setup transport event handlers
     */
    private setupTransportHandlers;
    /**
     * Setup heartbeat mechanism
     */
    private setupHeartbeat;
    /**
     * Check all peers for heartbeat timeout and send heartbeats
     */
    private checkHeartbeats;
    /**
     * Handle new peer connection
     */
    private handleConnection;
    /**
     * Handle peer disconnection
     */
    private handleDisconnection;
    /**
     * Handle incoming message from a peer
     */
    private handlePeerMessage;
    /**
     * Decode and handle an intent from a peer
     */
    private handleIntent;
    /**
     * Handle incoming RPC message from a peer
     */
    private handleRPC;
    /**
     * Check rate limit for a peer
     * Returns true if message should be processed, false if rate limit exceeded
     */
    private checkRateLimit;
    /**
     * Debug logging
     */
    private log;
}

import { MessageType, MessagePriority } from "./types";
import { MessageWrapperPool } from "./buffer-pool";
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
export class ServerNetwork {
    constructor(config) {
        /** Per-peer state tracking */
        this.peers = new Map();
        /** Per-peer snapshot registries - this is the key feature! */
        this.peerSnapshotRegistries = new Map();
        /** Track last processed client tick per peer per intent kind (for client-side prediction) */
        this.lastProcessedClientTick = new Map();
        /** Track last sent snapshot hashes per peer per type (for delta detection) */
        this.lastSnapshotHashes = new Map();
        /** Intent handlers: kind -> handler[] (supports multiple handlers) */
        this.intentHandlers = new Map();
        /** Global intent handler called for ALL intents before specific handlers */
        this.anyIntentHandlers = [];
        /** RPC method handlers: method -> handler[] (supports multiple handlers) */
        this.rpcHandlers = new Map();
        /** Connection lifecycle handlers */
        this.connectionHandlers = [];
        this.disconnectionHandlers = [];
        /** Message wrapper pool for zero-allocation message wrapping */
        this.messagePool = null;
        /** Heartbeat interval timer */
        this.heartbeatTimer = null;
        this.transport = config.transport;
        this.intentRegistry = config.intentRegistry;
        this.createPeerSnapshotRegistry = config.createPeerSnapshotRegistry;
        this.rpcRegistry = config.rpcRegistry;
        this.config = {
            maxMessageSize: config.config?.maxMessageSize ?? 65536,
            debug: config.config?.debug ?? false,
            maxMessagesPerSecond: config.config?.maxMessagesPerSecond ?? 100,
            maxSendQueueSize: config.config?.maxSendQueueSize ?? 100,
            enableBufferPooling: config.config?.enableBufferPooling ?? true,
            heartbeatInterval: config.config?.heartbeatInterval ?? 30000,
            heartbeatTimeout: config.config?.heartbeatTimeout ?? 60000,
            lagSimulation: config.config?.lagSimulation ?? 0,
        };
        // Initialize message pool if buffer pooling is enabled
        if (this.config.enableBufferPooling) {
            this.messagePool = new MessageWrapperPool();
        }
        this.setupTransportHandlers();
        this.setupHeartbeat();
    }
    /**
     * Get the snapshot registry for a specific peer
     */
    getPeerSnapshotRegistry(peerId) {
        return this.peerSnapshotRegistries.get(peerId);
    }
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
    onIntent(intent, handler, validator) {
        let handlers = this.intentHandlers.get(intent.kind);
        if (!handlers) {
            handlers = [];
            this.intentHandlers.set(intent.kind, handlers);
        }
        // Wrap handler with validator if provided
        const wrappedHandler = (peerId, intent) => {
            if (validator) {
                if (!validator(peerId, intent)) {
                    this.log(`Intent validation failed for peer ${peerId}, kind ${intent.kind}`);
                    return;
                }
            }
            // Update lastProcessedClientTick AFTER validation passes
            // This ensures only valid intents update the confirmed tick
            let peerTicks = this.lastProcessedClientTick.get(peerId);
            if (!peerTicks) {
                peerTicks = new Map();
                this.lastProcessedClientTick.set(peerId, peerTicks);
            }
            peerTicks.set(intent.kind, intent.tick);
            handler(peerId, intent);
        };
        handlers.push(wrappedHandler);
        // Return unsubscribe function
        return () => {
            const handlers = this.intentHandlers.get(intent.kind);
            if (handlers) {
                const index = handlers.indexOf(wrappedHandler);
                if (index > -1) {
                    handlers.splice(index, 1);
                }
            }
        };
    }
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
    onAnyIntent(handler) {
        this.anyIntentHandlers.push(handler);
        // Return unsubscribe function
        return () => {
            const index = this.anyIntentHandlers.indexOf(handler);
            if (index > -1) {
                this.anyIntentHandlers.splice(index, 1);
            }
        };
    }
    /**
     * Register a handler for new connections
     */
    onConnection(handler) {
        this.connectionHandlers.push(handler);
    }
    /**
     * Register a handler for disconnections
     */
    onDisconnection(handler) {
        this.disconnectionHandlers.push(handler);
    }
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
    sendRPC(peerId, rpc, data, priority = MessagePriority.NORMAL) {
        if (!this.rpcRegistry) {
            throw new Error('RpcRegistry not configured. Pass rpcRegistry to ServerNetworkConfig.');
        }
        const peer = this.peers.get(peerId);
        if (!peer) {
            this.log(`Cannot send RPC to unknown peer: ${peerId}`);
            return;
        }
        try {
            // Encode RPC
            const rpcData = this.rpcRegistry.encode(rpc, data);
            // Wrap with message type header (use pool if enabled)
            let message;
            if (this.messagePool) {
                message = this.messagePool.wrap(MessageType.CUSTOM, rpcData);
            }
            else {
                message = new Uint8Array(1 + rpcData.byteLength);
                message[0] = MessageType.CUSTOM;
                message.set(rpcData, 1);
            }
            // Check backpressure and queue if necessary
            if (peer.isBackpressured || peer.sendQueue.length > 0) {
                // Peer is experiencing backpressure, queue the message with priority
                this.queueMessage(peer, message, priority);
                // Release pooled buffer since we copied it in queueMessage
                if (this.messagePool) {
                    this.messagePool.release(message);
                }
                return;
            }
            // Try to send immediately
            this.sendMessageToPeer(peer, message);
            // Release pooled buffer after send
            if (this.messagePool) {
                this.messagePool.release(message);
            }
            this.log(`Sent RPC (method: ${rpc.method}) to peer: ${peerId}`);
        }
        catch (error) {
            this.log(`Failed to send RPC to peer ${peerId}: ${error}`);
        }
    }
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
    sendRpcBroadcast(rpc, data, priority = MessagePriority.NORMAL) {
        for (const peerId of this.getPeerIds()) {
            this.sendRPC(peerId, rpc, data, priority);
        }
    }
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
    onRPC(rpc, handler) {
        if (!this.rpcRegistry) {
            throw new Error('RpcRegistry not configured. Pass rpcRegistry to ServerNetworkConfig.');
        }
        let handlers = this.rpcHandlers.get(rpc.method);
        if (!handlers) {
            handlers = [];
            this.rpcHandlers.set(rpc.method, handlers);
        }
        handlers.push(handler);
        // Return unsubscribe function
        return () => {
            const handlers = this.rpcHandlers.get(rpc.method);
            if (handlers) {
                const index = handlers.indexOf(handler);
                if (index > -1) {
                    handlers.splice(index, 1);
                }
            }
        };
    }
    /**
     * Send a snapshot to a specific peer using their dedicated snapshot registry (type-safe)
     * @template T The specific snapshot update type
     * @param priority Message priority (default: NORMAL)
     */
    sendSnapshotToPeer(peerId, type, snapshot, priority = MessagePriority.NORMAL) {
        const peer = this.peers.get(peerId);
        if (!peer) {
            this.log(`Cannot send snapshot to unknown peer: ${peerId}`);
            return;
        }
        const registry = this.peerSnapshotRegistries.get(peerId);
        if (!registry) {
            throw new Error(`No snapshot registry registered for peer: ${peerId}`);
        }
        // Encode snapshot using peer-specific registry
        const snapshotData = registry.encode(type, snapshot);
        // Wrap with message type header (use pool if enabled)
        let message;
        if (this.messagePool) {
            // Zero-copy path: reuse pooled buffer
            message = this.messagePool.wrap(MessageType.SNAPSHOT, snapshotData);
        }
        else {
            // Fallback path: allocate new buffer
            message = new Uint8Array(1 + snapshotData.byteLength);
            message[0] = MessageType.SNAPSHOT;
            message.set(snapshotData, 1);
        }
        // Check backpressure and queue if necessary
        if (peer.isBackpressured || peer.sendQueue.length > 0) {
            // Peer is experiencing backpressure, queue the message with priority
            this.queueMessage(peer, message, priority);
            // Release pooled buffer since we copied it in queueMessage
            if (this.messagePool) {
                this.messagePool.release(message);
            }
            return;
        }
        // Try to send immediately
        this.sendMessageToPeer(peer, message);
        // Update tracking
        peer.lastSentTick = snapshot.tick;
        this.log(`Sent snapshot (type: ${type}, tick: ${snapshot.tick}) to peer ${peerId}`);
    }
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
    sendSnapshotToPeerIfChanged(peerId, type, snapshot, priority = MessagePriority.NORMAL) {
        const peer = this.peers.get(peerId);
        if (!peer) {
            this.log(`Cannot send snapshot to unknown peer: ${peerId}`);
            return false;
        }
        const registry = this.peerSnapshotRegistries.get(peerId);
        if (!registry) {
            throw new Error(`No snapshot registry registered for peer: ${peerId}`);
        }
        // Encode snapshot (needed for both hashing and sending)
        const snapshotData = registry.encode(type, snapshot);
        // Get or create hash map for this peer
        let peerHashes = this.lastSnapshotHashes.get(peerId);
        if (!peerHashes) {
            peerHashes = new Map();
            this.lastSnapshotHashes.set(peerId, peerHashes);
        }
        // Compute hash of only the updates portion (skip typeId + tick)
        // Binary format: [typeId(1) + tick(4) + updates(...)]
        // We only want to hash the updates, not the tick
        const updatesData = snapshotData.subarray(5); // Skip first 5 bytes
        const currentHash = this.hashBinary(updatesData);
        const lastHash = peerHashes.get(type);
        // Only send if changed (or first time)
        if (lastHash === undefined || currentHash !== lastHash) {
            // Wrap with message type header (use pool if enabled)
            let message;
            if (this.messagePool) {
                // Zero-copy path: reuse pooled buffer
                message = this.messagePool.wrap(MessageType.SNAPSHOT, snapshotData);
            }
            else {
                // Fallback path: allocate new buffer
                message = new Uint8Array(1 + snapshotData.byteLength);
                message[0] = MessageType.SNAPSHOT;
                message.set(snapshotData, 1);
            }
            // Check backpressure and queue if necessary
            if (peer.isBackpressured || peer.sendQueue.length > 0) {
                this.queueMessage(peer, message, priority);
                if (this.messagePool) {
                    this.messagePool.release(message);
                }
            }
            else {
                // Try to send immediately
                this.sendMessageToPeer(peer, message);
            }
            // Update tracking
            peer.lastSentTick = snapshot.tick;
            peerHashes.set(type, currentHash);
            this.log(`Sent snapshot (type: ${type}, tick: ${snapshot.tick}) to peer ${peerId}`);
            return true; // Sent
        }
        this.log(`Skipped snapshot (type: ${type}) to peer ${peerId} - no change detected`);
        return false; // Skipped (no change)
    }
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
    hashBinary(data) {
        let hash = 2166136261; // FNV-1a 32-bit offset basis
        for (let i = 0; i < data.length; i++) {
            hash ^= data[i];
            hash = Math.imul(hash, 16777619); // FNV-1a 32-bit prime
        }
        return hash >>> 0; // Ensure unsigned 32-bit integer
    }
    /**
     * Queue a message with priority
     */
    queueMessage(peer, message, priority) {
        const queuedMessage = {
            data: new Uint8Array(message), // Copy to avoid pool reuse issues
            priority,
            timestamp: Date.now(),
        };
        // If queue is full, drop lowest priority message
        if (peer.sendQueue.length >= this.config.maxSendQueueSize) {
            // Sort by priority (ascending) to find lowest priority message
            peer.sendQueue.sort((a, b) => a.priority - b.priority);
            // Drop the lowest priority message (first in sorted array)
            const dropped = peer.sendQueue.shift();
            this.log(`Send queue full for peer ${peer.peerId}, dropping ${MessagePriority[dropped.priority]} priority message`);
        }
        // Insert message in priority order (higher priority first)
        let insertIndex = peer.sendQueue.length;
        for (let i = 0; i < peer.sendQueue.length; i++) {
            if (queuedMessage.priority > peer.sendQueue[i].priority) {
                insertIndex = i;
                break;
            }
        }
        peer.sendQueue.splice(insertIndex, 0, queuedMessage);
    }
    /**
     * Internal: Send a message to a peer, handling pooling and bandwidth tracking
     */
    sendMessageToPeer(peer, message) {
        // Track bandwidth
        this.trackBandwidth(peer, message.byteLength);
        // Send to peer
        const sendResult = peer.transport.send(message);
        // Handle both sync and async transports for pool cleanup
        if (this.messagePool) {
            if (sendResult instanceof Promise) {
                // Async transport: wait for send to complete before releasing
                sendResult.then(() => {
                    this.messagePool.release(message);
                    // Try to flush queue if there are pending messages
                    this.flushSendQueue(peer.peerId);
                }).catch(() => {
                    // Mark peer as backpressured on send failure
                    peer.isBackpressured = true;
                    this.messagePool.release(message);
                    this.log(`Send failed for peer ${peer.peerId}, marking as backpressured`);
                });
            }
            else {
                // Sync transport: release immediately
                this.messagePool.release(message);
            }
        }
        else if (sendResult instanceof Promise) {
            // No pool but async transport - still handle failures
            sendResult.catch(() => {
                peer.isBackpressured = true;
                this.log(`Send failed for peer ${peer.peerId}, marking as backpressured`);
            });
        }
    }
    /**
     * Flush send queue for a peer (called after successful sends)
     * Sends messages in priority order (highest priority first)
     */
    flushSendQueue(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer || peer.sendQueue.length === 0) {
            return;
        }
        // Mark as no longer backpressured
        peer.isBackpressured = false;
        // Send queued messages (up to a limit per flush to avoid blocking)
        // Queue is already sorted by priority (highest first)
        const maxMessagesPerFlush = 10;
        let sent = 0;
        while (peer.sendQueue.length > 0 && sent < maxMessagesPerFlush) {
            const queuedMessage = peer.sendQueue.shift();
            this.sendMessageToPeer(peer, queuedMessage.data);
            sent++;
            // If we hit backpressure again, stop flushing
            if (peer.isBackpressured) {
                break;
            }
        }
        if (peer.sendQueue.length > 0) {
            this.log(`Peer ${peerId} still has ${peer.sendQueue.length} queued messages`);
        }
    }
    /**
     * Track bandwidth usage for a peer
     */
    trackBandwidth(peer, bytes) {
        const now = Date.now();
        const windowStart = Math.floor(now / 1000) * 1000;
        // Reset counter if we're in a new time window
        if (peer.bandwidthWindow !== windowStart) {
            peer.bandwidthWindow = windowStart;
            peer.bytesSent = 0;
        }
        peer.bytesSent += bytes;
    }
    /**
     * Broadcast a snapshot to all connected peers (type-safe)
     * Each peer receives the snapshot encoded with their own snapshot registry
     * @template T The specific snapshot update type
     * @param priority Message priority (default: NORMAL)
     */
    broadcastSnapshot(type, snapshot, filter, priority = MessagePriority.NORMAL) {
        for (const peerId of this.peers.keys()) {
            if (filter && !filter(peerId)) {
                continue;
            }
            this.sendSnapshotToPeer(peerId, type, snapshot, priority);
        }
    }
    /**
     * Advanced: Broadcast with per-peer snapshot customization (type-safe)
     * Allows you to modify the snapshot for each peer (e.g., fog of war, interest management)
     * @template T The specific snapshot update type
     * @param priority Message priority (default: NORMAL)
     */
    broadcastSnapshotWithCustomization(type, baseSnapshot, customize, priority = MessagePriority.NORMAL) {
        for (const peerId of this.peers.keys()) {
            const customSnapshot = customize(peerId, baseSnapshot);
            this.sendSnapshotToPeer(peerId, type, customSnapshot, priority);
        }
    }
    /**
     * Get all connected peer IDs
     */
    getPeerIds() {
        return Array.from(this.peers.keys());
    }
    /**
     * Get peer state for a specific peer
     */
    getPeerState(peerId) {
        return this.peers.get(peerId);
    }
    /**
     * Update peer metadata
     */
    setPeerMetadata(peerId, key, value) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.metadata[key] = value;
        }
    }
    /**
     * Get bandwidth usage for a peer (bytes per second in current window)
     */
    getPeerBandwidth(peerId) {
        const peer = this.peers.get(peerId);
        return peer ? peer.bytesSent : 0;
    }
    /**
     * Get total bandwidth usage across all peers
     */
    getTotalBandwidth() {
        let total = 0;
        for (const peer of this.peers.values()) {
            total += peer.bytesSent;
        }
        return total;
    }
    /**
     * Check if a peer is experiencing backpressure
     */
    isPeerBackpressured(peerId) {
        const peer = this.peers.get(peerId);
        return peer ? peer.isBackpressured || peer.sendQueue.length > 0 : false;
    }
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
    getConfirmedClientTick(peerId, intentKind) {
        const peerTicks = this.lastProcessedClientTick.get(peerId);
        if (!peerTicks)
            return 0;
        return peerTicks.get(intentKind) ?? 0;
    }
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
    setConfirmedClientTick(peerId, intentKind, tick) {
        let peerTicks = this.lastProcessedClientTick.get(peerId);
        if (!peerTicks) {
            peerTicks = new Map();
            this.lastProcessedClientTick.set(peerId, peerTicks);
        }
        peerTicks.set(intentKind, tick);
    }
    /**
     * Close the server and all connections
     */
    close() {
        this.log("Closing server...");
        // Stop heartbeat timer
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        return this.transport.close();
    }
    /**
     * Setup transport event handlers
     */
    setupTransportHandlers() {
        this.transport.onConnection((peer, peerId) => {
            this.handleConnection(peer, peerId);
        });
        this.transport.onDisconnection((peerId) => {
            this.handleDisconnection(peerId);
        });
    }
    /**
     * Setup heartbeat mechanism
     */
    setupHeartbeat() {
        if (this.config.heartbeatInterval === 0) {
            return; // Heartbeats disabled
        }
        this.heartbeatTimer = setInterval(() => {
            this.checkHeartbeats();
        }, this.config.heartbeatInterval);
    }
    /**
     * Check all peers for heartbeat timeout and send heartbeats
     */
    checkHeartbeats() {
        const now = Date.now();
        const heartbeatMessage = new Uint8Array([MessageType.HEARTBEAT]);
        for (const [peerId, peer] of this.peers.entries()) {
            // Check if peer has timed out
            const timeSinceLastMessage = now - peer.lastMessageReceivedAt;
            if (timeSinceLastMessage > this.config.heartbeatTimeout) {
                this.log(`Peer ${peerId} timed out (no message for ${timeSinceLastMessage}ms)`);
                // Close the connection - this will trigger handleDisconnection
                peer.transport.close();
                continue;
            }
            // Send heartbeat to peer
            try {
                peer.transport.send(heartbeatMessage);
                this.trackBandwidth(peer, heartbeatMessage.byteLength);
            }
            catch (error) {
                this.log(`Failed to send heartbeat to peer ${peerId}: ${error}`);
            }
        }
    }
    /**
     * Handle new peer connection
     */
    handleConnection(peer, peerId) {
        this.log(`Peer connected: ${peerId}`);
        // Create peer state
        const now = Date.now();
        const peerState = {
            peerId,
            transport: peer,
            lastSentTick: 0,
            connectedAt: now,
            metadata: {},
            messageCount: 0,
            messageCountWindow: now,
            sendQueue: [],
            bytesSent: 0,
            bandwidthWindow: now,
            isBackpressured: false,
            lastMessageReceivedAt: now,
        };
        this.peers.set(peerId, peerState);
        // Create per-peer snapshot registry
        const snapshotRegistry = this.createPeerSnapshotRegistry();
        this.peerSnapshotRegistries.set(peerId, snapshotRegistry);
        // Initialize client tick tracking map (for client-side prediction)
        // Each intent kind will be tracked independently as intents arrive
        this.lastProcessedClientTick.set(peerId, new Map());
        // Setup message handler for this peer
        peer.onMessage((data) => {
            this.handlePeerMessage(peerId, data);
        });
        // Notify handlers
        for (const handler of this.connectionHandlers) {
            try {
                handler(peerId);
            }
            catch (error) {
                // Don't call log here as it might throw, use console.error directly
                if (this.config.debug) {
                    console.error(`[ServerNetwork] Error in connection handler: ${error}`);
                }
            }
        }
    }
    /**
     * Handle peer disconnection
     */
    handleDisconnection(peerId) {
        this.log(`Peer disconnected: ${peerId}`);
        this.peers.delete(peerId);
        this.peerSnapshotRegistries.delete(peerId);
        this.lastProcessedClientTick.delete(peerId);
        this.lastSnapshotHashes.delete(peerId);
        // Notify handlers
        for (const handler of this.disconnectionHandlers) {
            try {
                handler(peerId);
            }
            catch (error) {
                // Don't call log here as it might throw, use console.error directly
                if (this.config.debug) {
                    console.error(`[ServerNetwork] Error in disconnection handler: ${error}`);
                }
            }
        }
    }
    /**
     * Handle incoming message from a peer
     */
    handlePeerMessage(peerId, data) {
        // Update last message received timestamp
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.lastMessageReceivedAt = Date.now();
        }
        if (data.byteLength === 0) {
            this.log(`Received empty message from peer ${peerId}`);
            return;
        }
        if (data.byteLength > this.config.maxMessageSize) {
            this.log(`Message from peer ${peerId} exceeds max size: ${data.byteLength} > ${this.config.maxMessageSize}`);
            return;
        }
        const messageType = data[0];
        const payload = data.subarray(1);
        switch (messageType) {
            case MessageType.INTENT:
                this.handleIntent(peerId, payload);
                break;
            case MessageType.HEARTBEAT:
                // Heartbeat received - already updated lastMessageReceivedAt above
                this.log(`Received heartbeat from peer ${peerId}`);
                break;
            case MessageType.CUSTOM:
                this.handleRPC(peerId, payload);
                break;
            default:
                this.log(`Unknown message type ${messageType} from peer ${peerId}`);
        }
    }
    /**
     * Decode and handle an intent from a peer
     */
    handleIntent(peerId, data) {
        // Rate limiting check
        if (!this.checkRateLimit(peerId)) {
            this.log(`Rate limit exceeded for peer ${peerId}, dropping intent`);
            return;
        }
        try {
            // Decode using intent registry (extracts kind from first byte internally)
            const intent = this.intentRegistry.decode(data);
            this.log(`Received intent (kind: ${intent.kind}) from peer ${peerId}`);
            // Call global intent handlers first (e.g., for tracking pending responses)
            for (const handler of this.anyIntentHandlers) {
                try {
                    handler(peerId, intent);
                }
                catch (error) {
                    this.log(`Error in global intent handler: ${error}`);
                }
            }
            const handlers = this.intentHandlers.get(intent.kind);
            if (handlers && handlers.length > 0) {
                // Call all registered handlers
                // Note: lastProcessedClientTick is now updated inside the wrapped handler
                // after validation passes (see onIntent method)
                for (const handler of handlers) {
                    try {
                        handler(peerId, intent);
                    }
                    catch (error) {
                        this.log(`Error in intent handler: ${error}`);
                    }
                }
            }
            else {
                this.log(`No handler registered for intent kind: ${intent.kind}`);
            }
        }
        catch (error) {
            this.log(`Failed to decode intent from peer ${peerId}: ${error}`);
        }
    }
    /**
     * Handle incoming RPC message from a peer
     */
    handleRPC(peerId, data) {
        if (!this.rpcRegistry) {
            this.log("Received RPC but RpcRegistry not configured");
            return;
        }
        // Rate limiting check
        if (!this.checkRateLimit(peerId)) {
            this.log(`Rate limit exceeded for peer ${peerId}, dropping RPC`);
            return;
        }
        try {
            // Decode using RPC registry (returns { method, data })
            const decoded = this.rpcRegistry.decode(data);
            this.log(`Received RPC (method: ${decoded.method}) from peer ${peerId}`);
            // Call all method-specific handlers if registered
            const handlers = this.rpcHandlers.get(decoded.method);
            if (handlers && handlers.length > 0) {
                for (const handler of handlers) {
                    try {
                        handler(peerId, decoded.data);
                    }
                    catch (error) {
                        this.log(`Error in RPC handler: ${error}`);
                    }
                }
            }
            else {
                this.log(`No handler registered for RPC method: ${decoded.method}`);
            }
        }
        catch (error) {
            this.log(`Failed to decode RPC from peer ${peerId}: ${error}`);
        }
    }
    /**
     * Check rate limit for a peer
     * Returns true if message should be processed, false if rate limit exceeded
     */
    checkRateLimit(peerId) {
        if (this.config.maxMessagesPerSecond === 0) {
            return true; // Rate limiting disabled
        }
        const peer = this.peers.get(peerId);
        if (!peer) {
            return false;
        }
        const now = Date.now();
        const windowStart = Math.floor(now / 1000) * 1000; // Start of current second
        // Reset counter if we're in a new time window
        if (peer.messageCountWindow !== windowStart) {
            peer.messageCountWindow = windowStart;
            peer.messageCount = 0;
        }
        // Check if limit would be exceeded BEFORE incrementing
        if (peer.messageCount >= this.config.maxMessagesPerSecond) {
            return false;
        }
        // Only increment if we're allowing this message
        peer.messageCount++;
        return true;
    }
    /**
     * Debug logging
     */
    log(message) {
        if (this.config.debug) {
            console.log(`[ServerNetwork] ${message}`);
        }
    }
}

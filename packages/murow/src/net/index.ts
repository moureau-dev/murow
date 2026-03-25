/**
 * @module net
 *
 * Transport-agnostic networking layer for multiplayer games
 *
 * This module provides generic client/server abstractions that work with any transport layer
 * (WebSocket, WebRTC, UDP, Socket.io, etc.)
 *
 * Key features:
 * - Per-peer snapshot registry tracking (fog of war, interest management)
 * - Type-safe intent/snapshot encoding
 * - Pluggable transport adapters
 * - Connection lifecycle management
 *
 * @example
 * ```typescript
 * import { ServerNetwork, ClientNetwork } from '@mococa/net';
 * import { BunWebSocketServerTransport } from '@mococa/net/transports/bun-websocket';
 * import { IntentRegistry, SnapshotRegistry } from '@mococa/protocol';
 *
 * // Server setup
 * const transport = BunWebSocketServerTransport.create(3000);
 * const server = new ServerNetwork({
 *   transport,
 *   intentRegistry: new IntentRegistry(),
 * });
 *
 * // Per-peer snapshot registry factory
 * const server = new ServerNetwork({
 *   transport,
 *   intentRegistry: new IntentRegistry(),
 *   createPeerSnapshotRegistry: () => {
 *     const registry = new SnapshotRegistry();
 *     registry.register('GameState', gameStateCodec);
 *     return registry;
 *   }
 * });
 *
 * // Handle intents
 * server.onIntent(IntentKind.Move, (peerId, intent) => {
 *   console.log(`Player ${peerId} moved:`, intent);
 * });
 *
 * // Broadcast snapshots (each peer uses their own registry)
 * server.broadcastSnapshot('GameState', {
 *   tick: 100,
 *   updates: { players: [...] }
 * });
 * ```
 */

export * from "./types";
export * from "./server";
export * from "./client";
export * from "./adapters/bun-websocket";
export * from "./buffer-pool";
export * from "./validators";

// Re-export commonly used enums for convenience
export { MessageType, MessagePriority } from "./types";

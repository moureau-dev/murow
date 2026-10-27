/**
 * @module net
 *
 * Transport and wire primitives for multiplayer games.
 *
 * This module is the agnostic base: transport adapters, packet helpers, and
 * session identity. It does not know about ECS, snapshots, prediction, or game
 * authority. The opinionated ECS backend is `murow/netcode`.
 *
 * @example
 * ```typescript
 * import { BunWebSocketServerTransport } from 'murow/net';
 * import { ServerMessage, packet } from 'murow/net/wire';
 *
 * const transport = BunWebSocketServerTransport.create(3000);
 * peer.send(packet(ServerMessage.Snapshot, payload));
 * ```
 */

export * from "./types";
export * from "./adapters/bun-websocket";
export * from "./adapters/virtual-network";
export * from "./adapters/memory-transport";
export * as Transports from "./adapters";
export * from "./wire";

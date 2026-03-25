import type { Server, ServerWebSocket } from "bun";
import type { TransportAdapter, ServerTransportAdapter } from "../types";
/**
 * Bun WebSocket transport adapter for client-side connections
 */
export declare class BunWebSocketClientTransport implements TransportAdapter {
    private socket;
    private messageHandlers;
    private closeHandlers;
    private errorHandlers;
    constructor(socket: WebSocket);
    send(data: Uint8Array): void;
    onMessage(handler: (data: Uint8Array) => void): void;
    onClose(handler: () => void): void;
    onError(handler: (error: Error) => void): void;
    close(): void;
    private setupHandlers;
    /**
     * Static factory method to connect to a server
     */
    static connect(url: string): Promise<BunWebSocketClientTransport>;
}
/**
 * Bun WebSocket transport adapter for server-side peer connections
 */
export declare class BunWebSocketPeerTransport implements TransportAdapter {
    private socket;
    private messageHandlers;
    private closeHandlers;
    private errorHandlers;
    constructor(socket: ServerWebSocket<unknown>);
    send(data: Uint8Array): void;
    onMessage(handler: (data: Uint8Array) => void): void;
    onClose(handler: () => void): void;
    onError(handler: (error: Error) => void): void;
    close(): void;
    _handleOpen(): void;
    /**
     * Internal: Call message handlers (used by server adapter)
     */
    _handleMessage(data: Uint8Array): void;
    /**
     * Internal: Call close handlers (used by server adapter)
     */
    _handleClose(): void;
    /**
     * Internal: Call error handlers (used by server adapter)
     */
    _handleError(error: Error): void;
}
/**
 * Bun WebSocket server transport adapter
 */
export declare class BunWebSocketServerTransport implements ServerTransportAdapter<BunWebSocketPeerTransport> {
    private server;
    private peers;
    private connectionHandlers;
    private disconnectionHandlers;
    constructor(server: Server<unknown>);
    onConnection(handler: (peer: BunWebSocketPeerTransport, peerId: string) => void): void;
    onDisconnection(handler: (peerId: string) => void): void;
    getPeer(peerId: string): BunWebSocketPeerTransport | undefined;
    getPeerIds(): string[];
    close(): void;
    /**
     * Internal: Register a new peer (called from Bun server fetch handler)
     */
    _registerPeer(socket: ServerWebSocket<unknown>): string;
    /**
     * Internal: Handle peer message (called from Bun server message handler)
     */
    _handlePeerMessage(peerId: string, data: Uint8Array): void;
    /**
     * Internal: Handle peer disconnection (called from Bun server close handler)
     */
    _handlePeerDisconnection(peerId: string): void;
    _handlePeerConnection(peerId: string): void;
    /**
     * Static factory method to create a Bun WebSocket server
     */
    static create(port: number): BunWebSocketServerTransport;
}

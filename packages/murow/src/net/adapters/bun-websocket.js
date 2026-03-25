import { generateId } from "../../core/generate-id/generate-id";
/**
 * Bun WebSocket transport adapter for client-side connections
 */
export class BunWebSocketClientTransport {
    constructor(socket) {
        this.messageHandlers = [];
        this.closeHandlers = [];
        this.errorHandlers = [];
        this.socket = socket;
        this.setupHandlers();
    }
    send(data) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(data);
        }
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onClose(handler) {
        this.closeHandlers.push(handler);
    }
    onError(handler) {
        this.errorHandlers.push(handler);
    }
    close() {
        this.socket.close();
    }
    setupHandlers() {
        this.socket.binaryType = "arraybuffer";
        this.socket.addEventListener("message", (event) => {
            if (event.data instanceof ArrayBuffer) {
                const data = new Uint8Array(event.data);
                for (const handler of this.messageHandlers) {
                    handler(data);
                }
            }
            else {
                // Warn about non-binary messages
                const error = new Error(`Unexpected message type: ${typeof event.data}`);
                for (const handler of this.errorHandlers) {
                    handler(error);
                }
            }
        });
        this.socket.addEventListener("close", () => {
            for (const handler of this.closeHandlers) {
                handler();
            }
        });
        this.socket.addEventListener("error", () => {
            const error = new Error("WebSocket error");
            for (const handler of this.errorHandlers) {
                handler(error);
            }
        });
    }
    /**
     * Static factory method to connect to a server
     */
    static connect(url) {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url);
            const transport = new BunWebSocketClientTransport(socket);
            socket.addEventListener("open", () => {
                resolve(transport);
            });
            socket.addEventListener("error", (error) => {
                reject(error);
            });
        });
    }
}
/**
 * Bun WebSocket transport adapter for server-side peer connections
 */
export class BunWebSocketPeerTransport {
    constructor(socket) {
        this.messageHandlers = [];
        this.closeHandlers = [];
        this.errorHandlers = [];
        this.socket = socket;
    }
    send(data) {
        this.socket.send(data);
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onClose(handler) {
        this.closeHandlers.push(handler);
    }
    onError(handler) {
        this.errorHandlers.push(handler);
    }
    close() {
        this.socket.close();
    }
    _handleOpen() {
        // No-op for server peer transport
    }
    /**
     * Internal: Call message handlers (used by server adapter)
     */
    _handleMessage(data) {
        for (const handler of this.messageHandlers) {
            handler(data);
        }
    }
    /**
     * Internal: Call close handlers (used by server adapter)
     */
    _handleClose() {
        for (const handler of this.closeHandlers) {
            handler();
        }
    }
    /**
     * Internal: Call error handlers (used by server adapter)
     */
    _handleError(error) {
        for (const handler of this.errorHandlers) {
            handler(error);
        }
    }
}
/**
 * Bun WebSocket server transport adapter
 */
export class BunWebSocketServerTransport {
    constructor(server) {
        this.peers = new Map();
        this.connectionHandlers = [];
        this.disconnectionHandlers = [];
        this.server = server;
    }
    onConnection(handler) {
        this.connectionHandlers.push(handler);
    }
    onDisconnection(handler) {
        this.disconnectionHandlers.push(handler);
    }
    getPeer(peerId) {
        return this.peers.get(peerId);
    }
    getPeerIds() {
        return Array.from(this.peers.keys());
    }
    close() {
        this.server.stop();
        this.peers.clear();
    }
    /**
     * Internal: Register a new peer (called from Bun server fetch handler)
     */
    _registerPeer(socket) {
        const peerId = generateId({ prefix: "peer_" });
        const peer = new BunWebSocketPeerTransport(socket);
        this.peers.set(peerId, peer);
        // Notify connection handlers
        for (const handler of this.connectionHandlers) {
            handler(peer, peerId);
        }
        return peerId;
    }
    /**
     * Internal: Handle peer message (called from Bun server message handler)
     */
    _handlePeerMessage(peerId, data) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer._handleMessage(data);
        }
    }
    /**
     * Internal: Handle peer disconnection (called from Bun server close handler)
     */
    _handlePeerDisconnection(peerId) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer._handleClose();
            this.peers.delete(peerId);
            // Notify disconnection handlers
            for (const handler of this.disconnectionHandlers) {
                handler(peerId);
            }
        }
    }
    _handlePeerConnection(peerId) {
        const peer = this.peers.get(peerId);
        if (peer) {
            for (const handler of this.connectionHandlers) {
                handler(peer, peerId);
            }
        }
    }
    /**
     * Static factory method to create a Bun WebSocket server
     */
    static create(port) {
        // Peer ID tracking per socket
        const socketToPeerId = new WeakMap();
        let transport;
        const server = Bun.serve({
            port,
            fetch(req, server) {
                // Upgrade HTTP request to WebSocket
                if (server.upgrade(req)) {
                    return; // Connection upgraded
                }
                return new Response("Expected WebSocket connection", { status: 400 });
            },
            websocket: {
                open(ws) {
                    // Register peer on connection
                    const peerId = transport._registerPeer(ws);
                    socketToPeerId.set(ws, peerId);
                    transport._handlePeerConnection(peerId);
                    transport.connectionHandlers.forEach((handler) => handler(transport.getPeer(peerId), peerId));
                },
                message(ws, message) {
                    // Handle incoming message
                    const peerId = socketToPeerId.get(ws);
                    if (peerId && message instanceof Uint8Array) {
                        transport._handlePeerMessage(peerId, message);
                    }
                    else if (peerId && message instanceof ArrayBuffer) {
                        transport._handlePeerMessage(peerId, new Uint8Array(message));
                    }
                },
                close(ws) {
                    // Handle disconnection
                    const peerId = socketToPeerId.get(ws);
                    if (peerId) {
                        transport._handlePeerDisconnection(peerId);
                        socketToPeerId.delete(ws);
                    }
                },
            },
        });
        transport = new BunWebSocketServerTransport(server);
        return transport;
    }
}

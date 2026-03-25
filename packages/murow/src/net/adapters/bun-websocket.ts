import type { Server, ServerWebSocket } from "bun";
import type { TransportAdapter, ServerTransportAdapter } from "../types";
import { generateId } from "../../core/generate-id/generate-id";

/**
 * Bun WebSocket transport adapter for client-side connections
 */
export class BunWebSocketClientTransport implements TransportAdapter {
	private socket: WebSocket;
	private messageHandlers: Array<(data: Uint8Array) => void> = [];
	private closeHandlers: Array<() => void> = [];
	private errorHandlers: Array<(error: Error) => void> = [];

	constructor(socket: WebSocket) {
		this.socket = socket;
		this.setupHandlers();
	}

	send(data: Uint8Array): void {
		if (this.socket.readyState === WebSocket.OPEN) {
			this.socket.send(data);
		}
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.messageHandlers.push(handler);
	}

	onClose(handler: () => void): void {
		this.closeHandlers.push(handler);
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandlers.push(handler);
	}

	close(): void {
		this.socket.close();
	}

	private setupHandlers(): void {
		this.socket.binaryType = "arraybuffer";

		this.socket.addEventListener("message", (event) => {
			if (event.data instanceof ArrayBuffer) {
				const data = new Uint8Array(event.data);
				for (const handler of this.messageHandlers) {
					handler(data);
				}
			} else {
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
	static connect(url: string): Promise<BunWebSocketClientTransport> {
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
export class BunWebSocketPeerTransport implements TransportAdapter {
	private socket: ServerWebSocket<unknown>;
	private messageHandlers: Array<(data: Uint8Array) => void> = [];
	private closeHandlers: Array<() => void> = [];
	private errorHandlers: Array<(error: Error) => void> = [];

	constructor(socket: ServerWebSocket<unknown>) {
		this.socket = socket;
	}

	send(data: Uint8Array): void {
		this.socket.send(data);
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.messageHandlers.push(handler);
	}

	onClose(handler: () => void): void {
		this.closeHandlers.push(handler);
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandlers.push(handler);
	}

	close(): void {
		this.socket.close();
	}

	_handleOpen(): void {
		// No-op for server peer transport
	}

	/**
	 * Internal: Call message handlers (used by server adapter)
	 */
	_handleMessage(data: Uint8Array): void {
		for (const handler of this.messageHandlers) {
			handler(data);
		}
	}

	/**
	 * Internal: Call close handlers (used by server adapter)
	 */
	_handleClose(): void {
		for (const handler of this.closeHandlers) {
			handler();
		}
	}

	/**
	 * Internal: Call error handlers (used by server adapter)
	 */
	_handleError(error: Error): void {
		for (const handler of this.errorHandlers) {
			handler(error);
		}
	}
}

/**
 * Bun WebSocket server transport adapter
 */
export class BunWebSocketServerTransport implements ServerTransportAdapter<BunWebSocketPeerTransport> {
	private server: Server<unknown>;
	private peers = new Map<string, BunWebSocketPeerTransport>();

	private connectionHandlers: Array<(peer: BunWebSocketPeerTransport, peerId: string) => void> = [];
	private disconnectionHandlers: Array<(peerId: string) => void> = [];

	constructor(server: Server<unknown>) {
		this.server = server;
	}

	onConnection(handler: (peer: BunWebSocketPeerTransport, peerId: string) => void): void {
		this.connectionHandlers.push(handler);
	}

	onDisconnection(handler: (peerId: string) => void): void {
		this.disconnectionHandlers.push(handler);
	}

	getPeer(peerId: string): BunWebSocketPeerTransport | undefined {
		return this.peers.get(peerId);
	}

	getPeerIds(): string[] {
		return Array.from(this.peers.keys());
	}

	close(): void {
		this.server.stop();
		this.peers.clear();
	}

	/**
	 * Internal: Register a new peer (called from Bun server fetch handler)
	 */
	_registerPeer(socket: ServerWebSocket<unknown>): string {
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
	_handlePeerMessage(peerId: string, data: Uint8Array): void {
		const peer = this.peers.get(peerId);
		if (peer) {
			peer._handleMessage(data);
		}
	}

	/**
	 * Internal: Handle peer disconnection (called from Bun server close handler)
	 */
	_handlePeerDisconnection(peerId: string): void {
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

	_handlePeerConnection(peerId: string): void {
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
	static create(port: number): BunWebSocketServerTransport {
		// Peer ID tracking per socket
		const socketToPeerId = new WeakMap<ServerWebSocket<unknown>, string>();

		let transport: BunWebSocketServerTransport;

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
					transport.connectionHandlers.forEach((handler) => handler(transport.getPeer(peerId)!, peerId));
				},
				message(ws, message) {
					// Handle incoming message
					const peerId = socketToPeerId.get(ws);
					if (peerId && message instanceof Uint8Array) {
						transport._handlePeerMessage(peerId, message);
					} else if (peerId && message instanceof ArrayBuffer) {
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

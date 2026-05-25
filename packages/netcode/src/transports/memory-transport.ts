import type { TransportAdapter, ServerTransportAdapter } from 'murow/net';

/**
 * In-process transport pair for tests. Wires a server adapter and one or
 * more client adapters together via microtask delivery. No queueing, no
 * latency simulation; `send` schedules a microtask to deliver to the
 * matching `onMessage`.
 */
export class MemoryServerTransport implements ServerTransportAdapter<MemoryPeerTransport> {
    private peers = new Map<string, MemoryPeerTransport>();
    private connectionHandler: ((peer: MemoryPeerTransport, peerId: string) => void) | null = null;
    private disconnectionHandler: ((peerId: string) => void) | null = null;
    private nextPeerId = 1;

    onConnection(handler: (peer: MemoryPeerTransport, peerId: string) => void): void {
        this.connectionHandler = handler;
    }

    onDisconnection(handler: (peerId: string) => void): void {
        this.disconnectionHandler = handler;
    }

    getPeer(peerId: string): MemoryPeerTransport | undefined {
        return this.peers.get(peerId);
    }

    getPeerIds(): string[] {
        return [...this.peers.keys()];
    }

    /**
     * Simulate a client connection. Returns the client-side adapter and
     * the server-assigned peer id. Fires the server's connection handler
     * synchronously; the client's `onOpen` fires on the next microtask.
     */
    connectClient(): { client: TransportAdapter; peerId: string } {
        const peerId = `peer_${this.nextPeerId++}`;
        const peer = new MemoryPeerTransport(peerId, this);
        this.peers.set(peerId, peer);

        this.connectionHandler?.(peer, peerId);
        peer._openClient();

        return { client: peer.clientView(), peerId };
    }

    /** Called by a peer when it disconnects. */
    _peerClosed(peerId: string): void {
        this.peers.delete(peerId);
        this.disconnectionHandler?.(peerId);
    }

    close(): void {
        for (const peerId of [...this.peers.keys()]) {
            this._peerClosed(peerId);
        }
    }
}

/**
 * Internal server-side adapter, one per connected peer. `send` goes to
 * the client; `onMessage` fires when the client sends.
 */
export class MemoryPeerTransport implements TransportAdapter {
    private serverMessageHandler: ((data: Uint8Array) => void) | null = null;
    private serverCloseHandler: (() => void) | null = null;
    private clientMessageHandler: ((data: Uint8Array) => void) | null = null;
    private clientCloseHandler: (() => void) | null = null;
    private clientOpenHandler: (() => void) | null = null;

    constructor(public readonly peerId: string, private server: MemoryServerTransport) { }

    // Server-side TransportAdapter
    send(data: Uint8Array): void {
        // Copy because callers may reuse the buffer.
        const copy = new Uint8Array(data);
        queueMicrotask(() => this.clientMessageHandler?.(copy));
    }
    onOpen(_handler: () => void): void { /* server side is open immediately */ }
    onMessage(handler: (data: Uint8Array) => void): void {
        this.serverMessageHandler = handler;
    }
    onClose(handler: () => void): void {
        this.serverCloseHandler = handler;
    }
    close(): void {
        this.serverCloseHandler?.();
        this.clientCloseHandler?.();
        this.server._peerClosed(this.peerId);
    }

    /** Client-side adapter view: sends to the server, observes server messages. */
    clientView(): TransportAdapter {
        const self = this;
        return {
            send(data: Uint8Array) {
                const copy = new Uint8Array(data);
                queueMicrotask(() => self.serverMessageHandler?.(copy));
            },
            onOpen(handler: () => void) {
                self.clientOpenHandler = handler;
            },
            onMessage(handler: (data: Uint8Array) => void) {
                self.clientMessageHandler = handler;
            },
            onClose(handler: () => void) {
                self.clientCloseHandler = handler;
            },
            close() {
                self.clientCloseHandler?.();
                self.serverCloseHandler?.();
                self.server._peerClosed(self.peerId);
            },
        };
    }

    _openClient(): void {
        queueMicrotask(() => this.clientOpenHandler?.());
    }
}

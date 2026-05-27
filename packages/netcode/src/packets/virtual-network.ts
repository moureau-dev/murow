import { SimpleRNG } from 'murow/core/simple-rng';
import type { TransportAdapter, ServerTransportAdapter } from 'murow/net';

export interface JitterConfig {
    baseLatencyMs: number;
    jitterMs: number;
    lossChance: number;
    /**
     * Chance per packet of having its arrival time perturbed enough to
     * overtake or fall behind nearby packets. Real networks reorder; this
     * stresses the netcode's resilience to out-of-order delivery.
     */
    reorderChance?: number;
    /** Magnitude of the reorder skew, in ms. */
    reorderSkewMs?: number;
}

interface DeliverySlot {
    deliverAt: number;
    seq: number;
    deliver: () => void;
}

export class VirtualNetwork {
    private now = 0;
    private slots: DeliverySlot[] = [];
    private seq = 0;

    nowMs(): number { return this.now; }

    schedule(latencyMs: number, fn: () => void): void {
        this.slots.push({ deliverAt: this.now + latencyMs, seq: this.seq++, deliver: fn });
    }

    advance(ms: number): void {
        this.now += ms;
        const due: DeliverySlot[] = [];
        const remaining: DeliverySlot[] = [];
        for (const slot of this.slots) {
            if (slot.deliverAt <= this.now) due.push(slot);
            else remaining.push(slot);
        }
        due.sort((a, b) => a.deliverAt - b.deliverAt || a.seq - b.seq);
        this.slots = remaining;
        for (const slot of due) slot.deliver();
    }

    pending(): number { return this.slots.length; }
}

export class VirtualPeerTransport implements TransportAdapter {
    serverOnMessage: ((data: Uint8Array) => void) | null = null;
    clientOnMessage: ((data: Uint8Array) => void) | null = null;
    serverOnClose: (() => void) | null = null;
    clientOnClose: (() => void) | null = null;
    clientOnOpen: (() => void) | null = null;
    closed = false;

    constructor(
        public readonly peerId: string,
        private vnet: VirtualNetwork,
        private rng: SimpleRNG,
        private cfg: JitterConfig,
    ) {}

    setConfig(cfg: JitterConfig): void { this.cfg = cfg; }

    private schedule(deliver: () => void): void {
        if (this.rng.chance(this.cfg.lossChance)) return;
        const jitter = this.rng.range(-this.cfg.jitterMs, this.cfg.jitterMs);
        let latency = Math.max(0, this.cfg.baseLatencyMs + jitter);
        const reorderChance = this.cfg.reorderChance ?? 0;
        if (reorderChance > 0 && this.rng.chance(reorderChance)) {
            const skew = this.rng.range(
                -(this.cfg.reorderSkewMs ?? 0),
                this.cfg.reorderSkewMs ?? 0,
            );
            latency = Math.max(0, latency + skew);
        }
        this.vnet.schedule(latency, deliver);
    }

    send(data: Uint8Array): void {
        if (this.closed) return;
        const copy = new Uint8Array(data);
        this.schedule(() => this.clientOnMessage?.(copy));
    }
    onOpen(_handler: () => void): void {}
    onMessage(handler: (data: Uint8Array) => void): void { this.serverOnMessage = handler; }
    onClose(handler: () => void): void { this.serverOnClose = handler; }
    close(): void {
        this.closed = true;
        this.serverOnClose?.();
        this.clientOnClose?.();
    }

    clientView(): TransportAdapter {
        const self = this;
        return {
            send(data: Uint8Array) {
                if (self.closed) return;
                const copy = new Uint8Array(data);
                self.schedule(() => self.serverOnMessage?.(copy));
            },
            onOpen(handler: () => void) { self.clientOnOpen = handler; },
            onMessage(handler: (data: Uint8Array) => void) { self.clientOnMessage = handler; },
            onClose(handler: () => void) { self.clientOnClose = handler; },
            close() { self.close(); },
        };
    }

    openClient(): void {
        this.vnet.schedule(0, () => this.clientOnOpen?.());
    }
}

export class VirtualServerTransport implements ServerTransportAdapter<VirtualPeerTransport> {
    private peers = new Map<string, VirtualPeerTransport>();
    private connectionHandler: ((peer: VirtualPeerTransport, peerId: string) => void) | null = null;
    private nextId = 1;

    constructor(
        private vnet: VirtualNetwork,
        private rng: SimpleRNG,
        public cfg: JitterConfig,
    ) {}

    setConfig(cfg: JitterConfig): void {
        this.cfg = cfg;
        for (const p of this.peers.values()) p.setConfig(cfg);
    }

    onConnection(handler: (peer: VirtualPeerTransport, peerId: string) => void): void {
        this.connectionHandler = handler;
    }
    onDisconnection(_handler: (peerId: string) => void): void {}
    getPeer(peerId: string): VirtualPeerTransport | undefined { return this.peers.get(peerId); }
    getPeerIds(): string[] { return [...this.peers.keys()]; }
    close(): void {
        for (const p of this.peers.values()) p.close();
        this.peers.clear();
    }

    connectClient(): { client: TransportAdapter; peerId: string } {
        const peerId = `peer_${this.nextId++}`;
        const peer = new VirtualPeerTransport(peerId, this.vnet, this.rng, this.cfg);
        this.peers.set(peerId, peer);
        this.connectionHandler?.(peer, peerId);
        peer.openClient();
        return { client: peer.clientView(), peerId };
    }
}

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

const DEFAULT_SEED = 0x5eed;

/** A pristine link: no latency, jitter, loss, or reorder. Opt into adversity explicitly. */
const DEFAULT_CFG: Readonly<JitterConfig> = Object.freeze({ baseLatencyMs: 0, jitterMs: 0, lossChance: 0 });

interface DeliverySlot {
    deliverAt: number;
    seq: number;
    deliver: () => void;
}

/**
 * A virtual network that allows scheduling packet deliveries with configurable latency, jitter, and loss.
 * The VirtualPeerTransport and VirtualServerTransport use this to simulate network conditions for testing.
 */
export class VirtualNetwork {
    private now = 0;
    private slots: DeliverySlot[] = [];
    private seq = 0;

    /** Return the current time in milliseconds. */
    nowMs(): number { return this.now; }

    /**
     * Schedule a packet for delivery after the given latency.
     */
    schedule(latencyMs: number, fn: () => void): void {
        this.slots.push({ deliverAt: this.now + latencyMs, seq: this.seq++, deliver: fn });
    }

    /**
     * Advance the virtual clock by the given number of milliseconds,
     * delivering any scheduled packets that are now due.
     */
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

    /** Return the number of pending packets. */
    pending(): number { return this.slots.length; }
}

interface VirtualPeerTransportProps {
    peerId: string;
    vnet?: VirtualNetwork;
    rng?: SimpleRNG;
    cfg?: JitterConfig;
}

/**
 * A TransportAdapter that simulates a network connection with configurable latency, jitter, and packet loss.
 * Created by the VirtualServerTransport for each connected client.
 */
export class VirtualPeerTransport implements TransportAdapter {
    readonly peerId: string;
    private readonly vnet: VirtualNetwork;
    private readonly rng: SimpleRNG;
    private cfg: JitterConfig;

    serverOnMessage: ((data: Uint8Array) => void) | null = null;
    clientOnMessage: ((data: Uint8Array) => void) | null = null;
    serverOnClose: (() => void) | null = null;
    clientOnClose: (() => void) | null = null;
    clientOnOpen: (() => void) | null = null;
    closed = false;

    constructor(props: VirtualPeerTransportProps) {
        if (!props.peerId) throw new Error('peerId is required');

        this.peerId = props.peerId;
        this.vnet = props.vnet ?? new VirtualNetwork();
        this.rng = props.rng ?? new SimpleRNG(DEFAULT_SEED);
        this.cfg = props.cfg ?? DEFAULT_CFG;
    }

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

    /**
     * Return a TransportAdapter view of this peer, for use by the client side.
     */
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

    /** Open the client connection. */
    openClient(): void {
        this.vnet.schedule(0, () => this.clientOnOpen?.());
    }
}

export interface VirtualServerTransportProps {
    vnet?: VirtualNetwork;
    /** Master rng. Per-peer streams derive their seed from it. Takes precedence over `seed`. */
    rng?: SimpleRNG;
    /** Seed for the master rng when `rng` is not provided. Defaults to a fixed constant. */
    seed?: number;
    cfg?: JitterConfig;
}

/**
 * A ServerTransportAdapter that simulates a network with configurable latency, jitter, and packet loss.
 * Useful for testing netcode under various conditions without needing real network connections.
 *
 * Deterministic: a fixed `seed` reproduces the same conditions. Each peer gets an independent
 * rng stream seeded from the master, so one peer's traffic never perturbs another's.
 */
export class VirtualServerTransport implements ServerTransportAdapter<VirtualPeerTransport> {
    private peers = new Map<string, VirtualPeerTransport>();
    private connectionHandler: ((peer: VirtualPeerTransport, peerId: string) => void) | null = null;
    private nextId = 1;

    private readonly vnet: VirtualNetwork;
    private readonly master: SimpleRNG;
    private cfg: JitterConfig;

    constructor(props: VirtualServerTransportProps = {}) {
        this.vnet = props.vnet ?? new VirtualNetwork();
        this.master = props.rng ?? new SimpleRNG(props.seed ?? DEFAULT_SEED);
        this.cfg = props.cfg ?? DEFAULT_CFG;
    }

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
        const peer = new VirtualPeerTransport({
            peerId,
            vnet: this.vnet,
            rng: new SimpleRNG(this.master.int(0, 0x7fffffff)),
            cfg: this.cfg,
        });

        this.peers.set(peerId, peer);
        this.connectionHandler?.(peer, peerId);
        peer.openClient();
        return { client: peer.clientView(), peerId };
    }
}

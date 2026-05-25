import { EventSystem } from 'murow/core/events';
import type { Peer } from '../ctx';

export interface ServerEventPayloads {
    /** A new peer connected. */
    connection: { peer: Peer };
    /** A peer disconnected. */
    disconnection: { peer: Peer; reason: string };
    /** An intent arrived from a peer and dispatched to its handler. */
    intent: { peer: Peer; kind: number; name: string; payload: unknown; tick: number };
    /** Engine-level intent failure: decode error or unknown kind. */
    'intent-failed': { peer: Peer; kind: number; reason: string };
    /** An RPC arrived from a peer. */
    rpc: { peer: Peer; name: string; args: unknown };
    /** A snapshot was packed and sent to a peer. */
    snapshot: { peer: Peer; tick: number; byteSize: number };
    /** Unhandled error. */
    error: { error: Error; context: string };
}

export interface ClientEventPayloads {
    /** Transport opened. */
    connected: {};
    /** Transport closed. */
    disconnected: { reason: string };
    /** Server sent a kick frame; disconnect imminent. */
    kicked: { reason: string };
    /** A snapshot arrived. */
    snapshot: { tick: number; byteSize: number };
    /** An RPC arrived from the server. */
    rpc: { name: string; args: unknown };
    /** A new networked entity appeared in the client's view. */
    spawn: { entity: number; components: Record<string, unknown> };
    /** A networked entity left the client's view (despawn or out-of-AOI). */
    despawn: { entity: number };
    /** Reconciliation rollback occurred. */
    reconciled: { rewindTick: number; replayed: number };
    /**
     * Fires once the server-assigned entity exists locally. The engine
     * buffers assignments that arrive before the matching spawn and
     * resolves them when the entity appears. The entity is auto-marked
     * predicted.
     */
    assigned: { entity: number };
    /** Unhandled error. */
    error: { error: Error; context: string };
}

type ToEventTuple<P> = {
    [K in keyof P]: [K, P[K]];
}[keyof P];

export type NetworkEvents<T extends 'client' | 'server'> = T extends 'server'
    ? Array<ToEventTuple<ServerEventPayloads>>
    : Array<ToEventTuple<ClientEventPayloads>>;

export class Network<T extends 'client' | 'server'> extends EventSystem<
    NetworkEvents<T> extends [string, unknown][] ? NetworkEvents<T> : never
> {
    constructor(events: string[]) {
        super({ events });
    }
}

/** Narrowed event surface. `emit` is engine-internal. */
export type PublicEventSurface<T extends 'client' | 'server'> = Pick<
    Network<T>,
    'on' | 'once' | 'off'
>;

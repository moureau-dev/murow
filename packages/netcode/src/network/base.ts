import { EventSystem } from 'murow/core/events';
import type { Peer } from '../ctx';
import type { RpcPayload, RpcSchemaMap } from '../rpcs/define-rpcs';

/**
 * Discriminated union over every RPC name in `R`. `name` narrows
 * `payload` to that RPC's typed payload.
 */
export type RpcEvent<R extends RpcSchemaMap> = {
    [K in keyof R & string]: { name: K; payload: RpcPayload<R, K> };
}[keyof R & string];

/** Same as `RpcEvent<R>` but with the originating `peer` field. */
export type ServerRpcEvent<R extends RpcSchemaMap> = {
    [K in keyof R & string]: { peer: Peer; name: K; payload: RpcPayload<R, K> };
}[keyof R & string];

export interface ServerEventPayloads<R extends RpcSchemaMap = RpcSchemaMap> {
    /** A new peer connected. */
    connection: { peer: Peer };
    /** A peer disconnected. */
    disconnection: { peer: Peer; reason: string };
    /** An intent arrived from a peer and dispatched to its handler. */
    intent: { peer: Peer; kind: number; name: string; payload: unknown; tick: number };
    /** Engine-level intent failure: decode error or unknown kind. */
    'intent-failed': { peer: Peer; kind: number; reason: string };
    /** An RPC arrived from a peer. `name` and `payload` are correlated. */
    rpc: ServerRpcEvent<R>;
    /** A snapshot was packed and sent to a peer. */
    snapshot: { peer: Peer; tick: number; byteSize: number };
    /** Unhandled error. */
    error: { error: Error; context: string };
}

export interface ClientEventPayloads<R extends RpcSchemaMap = RpcSchemaMap> {
    /** Transport opened. */
    connected: {};
    /** Transport closed. */
    disconnected: { reason: string };
    /** Server sent a kick frame; disconnect imminent. */
    kicked: { reason: string };
    /** A snapshot arrived. */
    snapshot: { tick: number; byteSize: number };
    /** An RPC arrived from the server. `name` and `payload` are correlated. */
    rpc: RpcEvent<R>;
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

export type NetworkEvents<
    T extends 'client' | 'server',
    R extends RpcSchemaMap = RpcSchemaMap,
> = T extends 'server'
    ? Array<ToEventTuple<ServerEventPayloads<R>>>
    : Array<ToEventTuple<ClientEventPayloads<R>>>;

export class Network<
    T extends 'client' | 'server',
    R extends RpcSchemaMap = RpcSchemaMap,
> extends EventSystem<
    NetworkEvents<T, R> extends [string, unknown][] ? NetworkEvents<T, R> : never
> {
    constructor(events: string[]) {
        super({ events });
    }
}

/** Narrowed event surface. `emit` is engine-internal. */
export type PublicEventSurface<
    T extends 'client' | 'server',
    R extends RpcSchemaMap = RpcSchemaMap,
> = Pick<
    Network<T, R>,
    'on' | 'once' | 'off'
>;

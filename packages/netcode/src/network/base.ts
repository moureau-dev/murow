import { EventSystem } from 'murow/core/events';
import type { Peer } from '../ctx';
import type { RpcPayload, RpcSchemaMap } from '../rpcs/define-rpcs';
import type { SnapshotSchemaMap, MessagePayload } from '../messages/define-snapshots';

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

/** Discriminated union over every custom message in `S`. */
export type MessageEvent<S extends SnapshotSchemaMap> = {
    [K in keyof S & string]: { name: K; payload: MessagePayload<S, K> };
}[keyof S & string];

/** Same as {@link MessageEvent} but with the originating `peer` field. */
export type ServerMessageEvent<S extends SnapshotSchemaMap> = {
    [K in keyof S & string]: { peer: Peer; name: K; payload: MessagePayload<S, K> };
}[keyof S & string];

/** Peer-bound typed message sender handed to the `'baseline'` handler. */
export type SendFn<S extends SnapshotSchemaMap> =
    <K extends keyof S & string>(name: K, payload: MessagePayload<S, K>) => void;

export interface ServerEventPayloads<
    R extends RpcSchemaMap = RpcSchemaMap,
    S extends SnapshotSchemaMap = SnapshotSchemaMap,
> {
    /** A new peer connected. */
    connection: { peer: Peer };
    /** A peer disconnected. */
    disconnection: { peer: Peer; reason: string };
    /**
     * A peer's transport dropped but its session (entity + ack cursor) is held
     * for `reconnection.graceMs` so it can resume.
     */
    suspended: { peer: Peer; reason: string };
    /** A peer reconnected and resumed its held session. */
    reconnection: { peer: Peer };
    /** An intent arrived from a peer and dispatched to its handler. */
    intent: { peer: Peer; kind: number; name: string; payload: unknown; tick: number };
    /** Engine-level intent failure: decode error or unknown kind. */
    'intent-failed': { peer: Peer; kind: number; reason: string };
    /** An RPC arrived from a peer. `name` and `payload` are correlated. */
    rpc: ServerRpcEvent<R>;
    /** A custom message arrived from a peer. */
    message: ServerMessageEvent<S>;
    /** A peer needs its initial state. Send replicated channels with `send`. */
    baseline: { peer: Peer; resumed: boolean; send: SendFn<S> };
    /** A peer's baseline ack arrived; it is fully initialized. */
    synced: { peer: Peer; resumed: boolean };
    /** A snapshot was packed and sent to a peer. */
    snapshot: { peer: Peer; tick: number; byteSize: number };
    /** Unhandled error. */
    error: { error: Error; context: string };
}

export interface ClientEventPayloads<
    R extends RpcSchemaMap = RpcSchemaMap,
    S extends SnapshotSchemaMap = SnapshotSchemaMap,
> {
    /** Transport opened. */
    connected: {};
    /** Transport closed. */
    disconnected: { reason: string };
    /** The server issued or confirmed this client's session token. */
    session: { token: string; resumed: boolean };
    /** A reconnect resumed a prior session; the server is re-baselining. */
    reconnected: {};
    /** Server sent a kick packet; disconnect imminent. */
    kicked: { reason: string };
    /** A snapshot arrived. */
    snapshot: { tick: number; byteSize: number };
    /** An RPC arrived from the server. `name` and `payload` are correlated. */
    rpc: RpcEvent<R>;
    /** A custom message arrived from the server. */
    message: MessageEvent<S>;
    /** Every channel's initial state has been applied. */
    initialized: {};
    /** An intent's server-side outcome (accepted or rejected, with a reason code). */
    outcome: { sequence: number; accepted: boolean; reason: number };
    /** An unacked intent packet was resent (lost-intent recovery). */
    'intent-retransmit': { sequence: number };
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
    /** Round-trip measurement from the most recent `client.ping()`. */
    pong: { rtt: number };
    /** Unhandled error. */
    error: { error: Error; context: string };
}

type ToEventTuple<P> = {
    [K in keyof P]: [K, P[K]];
}[keyof P];

export type NetworkEvents<
    T extends 'client' | 'server',
    R extends RpcSchemaMap = RpcSchemaMap,
    S extends SnapshotSchemaMap = SnapshotSchemaMap,
> = T extends 'server'
    ? Array<ToEventTuple<ServerEventPayloads<R, S>>>
    : Array<ToEventTuple<ClientEventPayloads<R, S>>>;

export class Network<
    T extends 'client' | 'server',
    R extends RpcSchemaMap = RpcSchemaMap,
    S extends SnapshotSchemaMap = SnapshotSchemaMap,
> extends EventSystem<
    NetworkEvents<T, R, S> extends [string, unknown][] ? NetworkEvents<T, R, S> : never
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

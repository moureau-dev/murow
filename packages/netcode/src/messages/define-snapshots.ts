import { SnapshotRegistry } from 'murow/protocol';
import { PooledCodec, type ArrayField } from 'murow/core/pooled-codec';

/** A codec `defineSnapshots` can encode/decode. */
export interface MessageCodec<T> {
    encode(value: T): Uint8Array;
    decode(buf: Uint8Array): T;
}

/** A message's field schema: primitive field codecs plus `arrayOf(...)` arrays. */
export type SnapshotSchema = Record<string, any>;
export type SnapshotSchemaMap = Record<string, SnapshotSchema>;

/** Payload type for a named custom message, inferred from its schema. */
export type MessagePayload<S extends SnapshotSchemaMap, K extends keyof S> =
    ReturnType<PooledCodec<S[K]>['decode']>;

/**
 * Result of `defineSnapshots`. `registry` plugs into `GameServer`/
 * `GameClient` via `protocol.snapshots`; `__payloads` is a phantom used purely
 * for type inference on `sendMessage`/`broadcastMessage`.
 */
export interface DefinedSnapshots<S extends SnapshotSchemaMap> {
    readonly defs: { readonly [K in keyof S]: { readonly name: K; readonly codec: MessageCodec<MessagePayload<S, K>> } };
    readonly registry: SnapshotRegistry<any>;
    /** Phantom field for type inference, never read at runtime. */
    readonly __payloads: { readonly [K in keyof S]: MessagePayload<S, K> };
}

/** Array field for a message schema. Builds a pooled array codec. */
export function arrayOf<U extends object>(itemSchema: Record<string, any>): ArrayField<U> {
    return PooledCodec.array<U>(itemSchema);
}

/**
 * Declare custom (non-entity) messages the game sends alongside entity
 * snapshots. Bidirectional; the same registry serves the server and the client.
 * Each entry is a plain field schema; the pooled codec is built internally.
 *
 * @example
 * const snapshots = defineSnapshots({
 *   tiles: { cells: arrayOf({ index: u32, owner: u16 }) },
 *   match: { phase: u8, score: u32 },
 * });
 */
export function defineSnapshots<S extends SnapshotSchemaMap>(map: S): DefinedSnapshots<S> {
    const registry = new SnapshotRegistry<any>();
    const defs: any = {};
    for (const name of Object.keys(map) as (keyof S & string)[]) {
        const codec = new PooledCodec(map[name]);
        registry.register(name, codec);
        defs[name] = { name, codec };
    }
    return { defs, registry, __payloads: undefined as any };
}

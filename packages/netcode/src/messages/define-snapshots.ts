import { SnapshotRegistry } from 'murow/protocol';
import { PooledCodec, type ArrayField } from 'murow/core/pooled-codec';

/** A codec `defineSnapshots` can encode/decode. */
export interface MessageCodec<T> {
    encode(value: T): Uint8Array;
    decode(buf: Uint8Array): T;
}

/** A message's field schema: primitive field codecs plus `arrayOf(...)` arrays. */
export type SnapshotSchema = Record<string, any>;

/** A schema marked as a baseline channel, via {@link baseline}. */
export interface BaselineEntry<S extends SnapshotSchema = SnapshotSchema> {
    readonly __baseline: S;
}

/** One entry of a `defineSnapshots` map: a plain schema, or a `baseline(...)`. */
export type SnapshotEntry = SnapshotSchema | BaselineEntry;
export type SnapshotSchemaMap = Record<string, SnapshotEntry>;

/** The field schema behind an entry (unwraps `baseline(...)`). */
type SchemaOf<E> = E extends BaselineEntry<infer S> ? S : E;

/** Keys of `M` declared as baseline channels. */
export type BaselineKeys<M extends SnapshotSchemaMap> =
    { [K in keyof M]: M[K] extends BaselineEntry ? K : never }[keyof M];

/** Payload type for a named message, inferred from its schema. */
export type MessagePayload<M extends SnapshotSchemaMap, K extends keyof M> =
    ReturnType<PooledCodec<SchemaOf<M[K]>>['decode']>;

/**
 * Result of `defineSnapshots`. `registry` plugs into `GameServer`/`GameClient`
 * via `protocol.snapshots`; `baselineKeys` lists the channels that get an
 * initial baseline on join/resume; `__payloads` is a phantom for inference.
 */
export interface DefinedSnapshots<M extends SnapshotSchemaMap> {
    readonly defs: { readonly [K in keyof M]: { readonly name: K; readonly codec: MessageCodec<MessagePayload<M, K>> } };
    readonly registry: SnapshotRegistry<any>;
    readonly baselineKeys: readonly (keyof M & string)[];
    /** Phantom field for type inference, never read at runtime. */
    readonly __payloads: { readonly [K in keyof M]: MessagePayload<M, K> };
}

/** Array field for a message schema. Builds a pooled array codec. */
export function arrayOf<U extends object>(itemSchema: Record<string, any>): ArrayField<U> {
    return PooledCodec.array<U>(itemSchema);
}

/** Mark a message schema as a baseline channel: replay its full state on join and resume. */
export function baseline<S extends SnapshotSchema>(schema: S): BaselineEntry<S> {
    return { __baseline: schema };
}

function isBaseline(entry: SnapshotEntry): entry is BaselineEntry {
    return typeof entry === 'object' && entry !== null && '__baseline' in entry;
}

/**
 * Declare custom (non-entity) messages. Each entry is a plain field schema
 * (`{ tiles: { cells: arrayOf({...}) } }`) or a `baseline(...)`-wrapped one.
 * Baseline channels are the ones a joining or resuming peer receives whole.
 *
 * @example
 * const snapshots = defineSnapshots({
 *   tiles: baseline({ cells: arrayOf({ index: u32, owner: u16 }) }),
 *   vfx:   { spawns: arrayOf({ kind: u16, x: f32, y: f32 }) },
 * });
 */
export function defineSnapshots<M extends SnapshotSchemaMap>(map: M): DefinedSnapshots<M> {
    const registry = new SnapshotRegistry<any>();
    const defs: any = {};
    const baselineKeys: string[] = [];
    for (const name of Object.keys(map) as (keyof M & string)[]) {
        const entry = map[name]!;
        const schema = (isBaseline(entry) ? entry.__baseline : entry) as SnapshotSchema;
        if (isBaseline(entry)) baselineKeys.push(name);
        const codec = new PooledCodec(schema);
        registry.register(name, codec);
        defs[name] = { name, codec };
    }
    return {
        defs,
        registry,
        baselineKeys: baselineKeys as readonly (keyof M & string)[],
        __payloads: undefined as any,
    };
}

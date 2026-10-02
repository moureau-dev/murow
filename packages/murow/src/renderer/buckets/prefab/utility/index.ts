/**
 * Shared prefab-bucket types: spec/prefab bases, the parser registry, and the
 * event channel. The bucket class itself lives in `../prefab` and extends the
 * core `Bucket`; this module holds only the plumbing its parsers and generics
 * need.
 */

import type { EventSystem } from '../../../../core/events';

export type PrefabMode = '2d' | '3d';

/**
 * `T | (string & {})` — accept a literal `T` (for autocomplete) but don't
 * collapse to plain `string`. Lets callers pass any string while still getting
 * suggestions for the known set.
 */
export type StringOr<T extends string> = T | (string & {});

/** A spec union with its `hitbox` field constrained to the hitbox names `HB`. */
export type SpecWithHitbox<S, HB extends string> =
    S extends unknown ? Omit<S, 'hitbox'> & { readonly hitbox?: StringOr<HB> } : never;

export interface PrefabSpecBase {
    readonly type: string;
    readonly id: string;
    /** Optional user-defined sidecar data carried through to the parsed prefab. */
    readonly metadata?: Record<string, unknown>;
}

export interface PrefabBase {
    readonly type: string;
    readonly id: string;
    /** User-defined sidecar data passed through from the spec. */
    readonly metadata?: Record<string, unknown>;
}

/** `clips-changed` fires when a prefab's animation set is mutated by lazy load/unload. */
export type PrefabBucketEvents = [
    ['clips-changed', { prefabId: string; added: readonly string[]; removed: readonly string[] }],
];

/** Context passed to each parser at load time, carrying the bucket's shared event channel. */
export interface PrefabParserContext {
    readonly events: EventSystem<PrefabBucketEvents>;
}

/**
 * Pluggable parser registry — keyed by spec `type`. Each entry knows how to turn
 * one variant of spec into its parsed prefab. The bucket itself is mode-agnostic;
 * the bucket (or any backend) registers parsers at construction.
 */
export type PrefabParser<Spec extends PrefabSpecBase = PrefabSpecBase, Prefab extends PrefabBase = PrefabBase> =
    (spec: Spec, ctx: PrefabParserContext) => Promise<Prefab> | Prefab;

export type PrefabParserMap<Spec extends PrefabSpecBase, Prefab extends PrefabBase> =
    Record<string, PrefabParser<Spec, Prefab>>;

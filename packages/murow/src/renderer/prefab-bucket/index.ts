/**
 * BasePrefabBucket — generic, renderer-agnostic registry of reusable spawn
 * templates. Backends (e.g. `@murow/webgpu`) extend this with specialized
 * spec/prefab unions; most users want the concrete `PrefabBucket` class
 * exported alongside this one (see `./prefab-bucket-concrete.ts`).
 *
 * Lifecycle:
 *   1. `add()` / `addAll()` collect specs (sync, no I/O)
 *   2. `load()` resolves all async work (fetch, parse) in parallel
 *   3. `get()` returns parsed prefabs by id; the bucket is now frozen
 *
 * Typed ids: with `const` generics, `bucket.get('typo')` is a compile-time
 * error once the bucket has been populated. The id-to-spec mapping is
 * threaded through generics so subclasses can narrow `get()`'s return type
 * to the specific prefab variant for that id (not just the union).
 */

import { EventSystem } from '../../core/events';

export type PrefabMode = '2d' | '3d';

/**
 * `T | (string & {})` — accept a literal `T` (for autocomplete) but don't
 * collapse to plain `string`. Lets callers pass any string while still getting
 * suggestions for the known set.
 */
export type StringOr<T extends string> = T | (string & {});

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
 * the webgpu package (or any other backend) registers parsers at construction.
 */
export type PrefabParser<Spec extends PrefabSpecBase = PrefabSpecBase, Prefab extends PrefabBase = PrefabBase> =
    (spec: Spec, ctx: PrefabParserContext) => Promise<Prefab> | Prefab;

export type PrefabParserMap<Spec extends PrefabSpecBase, Prefab extends PrefabBase> =
    Record<string, PrefabParser<Spec, Prefab>>;

export class BasePrefabBucket<
    M extends PrefabMode = PrefabMode,
    Spec extends PrefabSpecBase = PrefabSpecBase,
    Prefab extends PrefabBase = PrefabBase,
    Specs extends Record<string, Spec> = {},
> {
    readonly mode: M;
    /** Shared notification channel — see `PrefabBucketEvents`. */
    readonly events: EventSystem<PrefabBucketEvents>;
    private parsers: PrefabParserMap<Spec, Prefab>;
    private pending: Spec[] = [];
    private pendingIds: Set<string> = new Set();
    private prefabs: Map<string, Prefab> | null = null;

    constructor(mode: M, parsers: PrefabParserMap<Spec, Prefab> = {} as PrefabParserMap<Spec, Prefab>) {
        this.mode = mode;
        this.parsers = parsers;
        this.events = new EventSystem<PrefabBucketEvents>({ events: ['clips-changed'] });
    }

    /** Add a single spec. Throws if id is a duplicate or if the bucket is already loaded. */
    add<const S extends Spec>(
        spec: S,
    ): BasePrefabBucket<M, Spec, Prefab, Specs & { [K in S['id']]: S }> {
        if (this.prefabs) throw new Error(`PrefabBucket: cannot add after load() — bucket is frozen`);
        if (this.pendingIds.has(spec.id)) throw new Error(`PrefabBucket: duplicate id '${spec.id}'`);
        this.pending.push(spec);
        this.pendingIds.add(spec.id);
        return this as unknown as BasePrefabBucket<M, Spec, Prefab, Specs & { [K in S['id']]: S }>;
    }

    /**
     * Add multiple specs. Validates the whole batch (ids unique, not loaded) before
     * committing, so the bucket never lands in a half-applied state.
     */
    addAll<const Ss extends readonly Spec[]>(
        specs: Ss,
    ): BasePrefabBucket<M, Spec, Prefab, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }> {
        if (this.prefabs) throw new Error(`PrefabBucket: cannot add after load() — bucket is frozen`);
        const seen = new Set<string>();
        for (const s of specs) {
            if (this.pendingIds.has(s.id) || seen.has(s.id)) {
                throw new Error(`PrefabBucket: duplicate id '${s.id}'`);
            }
            seen.add(s.id);
        }
        for (const s of specs) {
            this.pending.push(s);
            this.pendingIds.add(s.id);
        }
        return this as unknown as BasePrefabBucket<M, Spec, Prefab, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }>;
    }

    /** Load all pending specs in parallel. Idempotent if already loaded. */
    async load(): Promise<void> {
        if (this.prefabs) return;
        const ctx: PrefabParserContext = { events: this.events };
        const parsed = await Promise.all(this.pending.map(s => {
            const parser = this.parsers[s.type];
            if (!parser) throw new Error(`PrefabBucket: no parser registered for type '${s.type}'`);
            return parser(s, ctx);
        }));
        const map = new Map<string, Prefab>();
        for (const p of parsed) map.set(p.id, p);
        this.prefabs = map;
        this.pending = [];
        this.pendingIds.clear();
    }

    /**
     * Returns the parsed prefab by id. The default return type is the prefab
     * union; subclasses may pass a second generic `R` to narrow the return
     * type per-id (e.g. mapping `Specs[K]` to its concrete prefab variant).
     *
     * Accepts any string at runtime but offers autocomplete for the known ids.
     */
    get<K extends keyof Specs & string, R extends Prefab = Prefab>(id: StringOr<K>): R {
        if (!this.prefabs) throw new Error(`PrefabBucket: get('${id}') called before load()`);
        const prefab = this.prefabs.get(id);
        if (!prefab) throw new Error(`PrefabBucket: unknown prefab id '${id}'`);
        return prefab as R;
    }

    /** True once `load()` has resolved. */
    get loaded(): boolean { return this.prefabs !== null; }

    /** Number of prefabs in the bucket (pending if not loaded, parsed if loaded). */
    get size(): number {
        return this.prefabs ? this.prefabs.size : this.pending.length;
    }

    /** All parsed prefabs. Throws if not loaded yet. Order is registration order. */
    entries(): Prefab[] {
        if (!this.prefabs) throw new Error(`PrefabBucket: entries() called before load()`);
        return Array.from(this.prefabs.values());
    }

    /**
     * Return all parsed prefabs whose `type` matches the given discriminator.
     * The default return type is the prefab union narrowed structurally;
     * subclasses may pass a second generic `R` to narrow further per-type.
     *
     * Accepts any string at runtime; offers autocomplete for the known types.
     */
    getAllByType<
        T extends Prefab['type'] & string,
        R extends Prefab = Extract<Prefab, { type: T }>,
    >(type: StringOr<T>): R[] {
        if (!this.prefabs) throw new Error(`PrefabBucket: getAllByType('${type}') called before load()`);
        const out: R[] = [];
        for (const p of this.prefabs.values()) {
            if (p.type === type) out.push(p as R);
        }
        return out;
    }

    /**
     * Drop every runtime-loaded clip across all prefabs, restoring each to
     * its parse-time animation set. Called by the renderer on destroy so
     * a kept-alive bucket doesn't carry runtime state into the next session.
     */
    resetAnimations(): void {
        if (!this.prefabs) return;
        for (const prefab of this.prefabs.values()) {
            (prefab as unknown as { resetAnimations?: () => void }).resetAnimations?.();
        }
    }
}

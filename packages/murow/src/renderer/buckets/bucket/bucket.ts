/**
 * Bucket — generic base class for typed registries of loadable resources.
 *
 * Lifecycle:
 *   1. `add()` / `addAll()` collect specs (sync, no I/O)
 *   2. `load()` resolves all async work (fetch, parse) in parallel
 *   3. `get()` returns parsed prefabs by id; the bucket is now frozen
 *
 * Accepts an optional parsers map in the constructor. When provided,
 * `load()` runs all pending specs through their registered parsers,
 * emitting `loading` and `load-complete` events as items resolve.
 *
 * Typed ids: with `const` generics, `bucket.get('typo')` is a compile-time
 * error once the bucket has been populated.
 */

import { EventSystem } from '../../../core/events';

export type StringOr<T extends string> = T | (string & {});

/** Minimal shape every spec must satisfy. */
export interface BucketSpecBase {
    readonly type: string;
    readonly id: string;
}

/** Minimal shape every parsed prefab must satisfy. */
export interface BucketPrefabBase {
    readonly type: string;
    readonly id: string;
}

/** Events common to all buckets. */
export type BucketBaseEvents = [
    ['loading', { loaded: number; total: number; id: string }],
    ['load-complete', { total: number }],
];

/** A parser turns a spec into its prefab. The context may carry event channels. */
export interface ParserContext {
    readonly events: EventSystem<any>;
}

export type BucketParser<Spec, Prefab> = (spec: Spec, ctx: ParserContext) => Promise<Prefab> | Prefab;

export class Bucket<
    Spec extends BucketSpecBase,
    Prefab extends BucketPrefabBase,
    Specs extends Record<string, Spec> = {},
    AdditionalEvents extends [string, unknown][] = never,
> {
    protected pending: Spec[] = [];
    protected pendingIds: Set<string> = new Set();
    protected prefabs: Map<string, Prefab> | null = null;
    private _parsers: Record<string, BucketParser<Spec, Prefab>> | null;
    readonly events: EventSystem<[...BucketBaseEvents, ...AdditionalEvents]>;

    constructor(
        parsers?: Record<string, BucketParser<Spec, Prefab>>,
        events?: EventSystem<[...BucketBaseEvents, ...AdditionalEvents]>,
    ) {
        this._parsers = parsers ?? null;
        this.events = events ?? new EventSystem({ events: ['loading', 'load-complete'] }) as any;
    }

    /** Add a single spec. Throws on duplicate id or if already loaded. */
    add<const S extends Spec>(
        spec: S,
    ): Bucket<Spec, Prefab, Specs & Record<S['id'], S>> {
        if (this.prefabs) throw new Error(`Bucket: cannot add after load() - bucket is frozen`);
        if (this.pendingIds.has(spec.id)) throw new Error(`Bucket: duplicate id '${spec.id}'`);
        this.pending.push(spec as Spec);
        this.pendingIds.add(spec.id);
        return this as unknown as Bucket<Spec, Prefab, Specs & Record<S['id'], S>>;
    }

    /** Add multiple specs atomically. Throws if any id is duplicate. */
    addAll<const Ss extends readonly Spec[]>(
        specs: Ss,
    ): Bucket<Spec, Prefab, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }> {
        if (this.prefabs) throw new Error(`Bucket: cannot add after load() - bucket is frozen`);
        const seen = new Set<string>();
        for (const s of specs) {
            if (this.pendingIds.has(s.id) || seen.has(s.id)) {
                throw new Error(`Bucket: duplicate id '${s.id}'`);
            }
            seen.add(s.id);
        }
        for (const s of specs) {
            this.pending.push(s as Spec);
            this.pendingIds.add(s.id);
        }
        return this as unknown as Bucket<Spec, Prefab, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }>;
    }

    /**
     * Load all pending specs in parallel. Emits `loading` as each item
     * resolves and `load-complete` when all are done.
     * Idempotent — safe to call multiple times.
     */
    async load(): Promise<void> {
        if (this.prefabs) return;
        if (!this._parsers) throw new Error('Bucket: no parsers registered — cannot load');
        const ctx: ParserContext = { events: this.events };
        let loaded = 0;
        const total = this.pending.length;

        const results = await Promise.all(
            this.pending.map(async (spec) => {
                const parser = this._parsers![spec.type];
                if (!parser) throw new Error(`Bucket: no parser registered for type '${spec.type}'`);
                const prefab = await parser(spec, ctx);
                loaded++;
                (this.events as EventSystem<any>).emit('loading', { loaded, total, id: spec.id });
                return prefab;
            }),
        );

        const map = new Map<string, Prefab>();
        for (const p of results) map.set(p.id, p);
        this.prefabs = map;
        this.pending = [];
        this.pendingIds.clear();

        (this.events as EventSystem<any>).emit('load-complete', { total });
    }

    /** Returns the parsed prefab by id. Autocompletes known ids and narrows to the matching variant. */
    get<K extends keyof Specs & string>(id: StringOr<K>): Extract<Prefab, { type: Specs[K]['type'] }> {
        if (!this.prefabs) throw new Error(`Bucket: get('${id}') called before load()`);
        const prefab = this.prefabs.get(id);
        if (!prefab) throw new Error(`Bucket: unknown prefab id '${id}'`);
        return prefab as Extract<Prefab, { type: Specs[K]['type'] }>;
    }

    /** True once `load()` has resolved. */
    get loaded(): boolean {
        return this.prefabs !== null;
    }

    /** Number of items (pending if not loaded, parsed if loaded). */
    get size(): number {
        return this.prefabs ? this.prefabs.size : this.pending.length;
    }

    /** All parsed prefabs. Throws if not loaded. Order is registration order. */
    entries(): Prefab[] {
        if (!this.prefabs) throw new Error(`Bucket: entries() called before load()`);
        return Array.from(this.prefabs.values());
    }
}

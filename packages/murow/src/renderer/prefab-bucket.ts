/**
 * PrefabBucket — typed registry of reusable spawn templates.
 *
 * Construct with `'2d'` or `'3d'` to pick the spec/prefab universe. The mode
 * narrows what `add()` will accept (2D buckets can't hold GLTFs, 3D buckets
 * can't hold spritesheets).
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
 *
 * Concrete spec/prefab unions and the spec→prefab parsing live in
 * the webgpu package, so this base stays renderer-agnostic.
 */

export type PrefabMode = '2d' | '3d';

export interface PrefabSpecBase {
    readonly type: string;
    readonly id: string;
}

export interface PrefabBase {
    readonly type: string;
    readonly id: string;
}

/**
 * Pluggable parser registry — keyed by spec `type`. Each entry knows how to turn
 * one variant of spec into its parsed prefab. The bucket itself is mode-agnostic;
 * the webgpu package (or any other backend) registers parsers at construction.
 */
export type PrefabParser<Spec extends PrefabSpecBase = PrefabSpecBase, Prefab extends PrefabBase = PrefabBase> =
    (spec: Spec) => Promise<Prefab> | Prefab;

export type PrefabParserMap<Spec extends PrefabSpecBase, Prefab extends PrefabBase> =
    Record<string, PrefabParser<Spec, Prefab>>;

export class PrefabBucket<
    M extends PrefabMode = PrefabMode,
    Spec extends PrefabSpecBase = PrefabSpecBase,
    Prefab extends PrefabBase = PrefabBase,
    Specs extends Record<string, Spec> = {},
> {
    readonly mode: M;
    private parsers: PrefabParserMap<Spec, Prefab>;
    private pending: Spec[] = [];
    private pendingIds: Set<string> = new Set();
    private prefabs: Map<string, Prefab> | null = null;

    constructor(mode: M, parsers: PrefabParserMap<Spec, Prefab> = {} as PrefabParserMap<Spec, Prefab>) {
        this.mode = mode;
        this.parsers = parsers;
    }

    /** Add a single spec. Throws if id is a duplicate or if the bucket is already loaded. */
    add<const S extends Spec>(
        spec: S,
    ): PrefabBucket<M, Spec, Prefab, Specs & { [K in S['id']]: S }> {
        if (this.prefabs) throw new Error(`PrefabBucket: cannot add after load() — bucket is frozen`);
        if (this.pendingIds.has(spec.id)) throw new Error(`PrefabBucket: duplicate id '${spec.id}'`);
        this.pending.push(spec);
        this.pendingIds.add(spec.id);
        return this as unknown as PrefabBucket<M, Spec, Prefab, Specs & { [K in S['id']]: S }>;
    }

    /**
     * Add multiple specs. Validates the whole batch (ids unique, not loaded) before
     * committing, so the bucket never lands in a half-applied state.
     */
    addAll<const Ss extends readonly Spec[]>(
        specs: Ss,
    ): PrefabBucket<M, Spec, Prefab, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }> {
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
        return this as unknown as PrefabBucket<M, Spec, Prefab, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }>;
    }

    /** Load all pending specs in parallel. Idempotent if already loaded. */
    async load(): Promise<void> {
        if (this.prefabs) return;
        const parsed = await Promise.all(this.pending.map(s => {
            const parser = this.parsers[s.type];
            if (!parser) throw new Error(`PrefabBucket: no parser registered for type '${s.type}'`);
            return parser(s);
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
     */
    get<K extends keyof Specs & string, R extends Prefab = Prefab>(id: K): R {
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
}

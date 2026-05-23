/**
 * PrefabBucket — typed registry of reusable spawn templates.
 *
 * Pass `'2d'` or `'3d'` to the constructor to pick the spec/prefab universe.
 * Parsers are wired implicitly; user code only sees `add`, `addAll`, `load`, `get`.
 *
 * ```ts
 * const bucket = new PrefabBucket('3d')
 *     .add({ type: 'gltf', id: 'minion', url: '/minion.glb' })
 *     .add({ type: 'grid', id: 'floor', size: 20, step: 0.33, lineWidth: 0.001 });
 *
 * await bucket.load();
 *
 * bucket.get('minion');  // typed as GltfPrefab — `.animations`, `.jointCount`, …
 * bucket.get('floor');   // typed as GridPrefab — `.size`, `.step`, `.lineWidth`
 * bucket.get('typo');    // ❌ TS error: '"typo"' not in '"minion" | "floor"'
 * ```
 */

import { BasePrefabBucket, type StringOr } from './index';
import { parsers2d, parsers3d } from './parsers';
import type {
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
    PrefabFor,
} from './specs';

// Mode → spec/prefab mapping. Keeps the public type signature compact.
type SpecForMode<M> = M extends '3d' ? Prefab3DSpec : Prefab2DSpec;
type PrefabUnionForMode<M> = M extends '3d' ? Prefab3D : Prefab2D;

/**
 * Registry of prefab specs and their parsed variants. The bucket tracks the mapping of
 * spec `id` strings to their parsed prefab types, so `get` narrows to the correct
 * prefab type based on the provided id. The bucket is mutable; call `add`/`addAll`
 * to register new specs and their prefab types. Call `load` to parse all registered
 * specs and populate the bucket's internal prefab registry.
 */
export class PrefabBucket<
    M extends '2d' | '3d' = '3d',
    Specs extends Record<string, SpecForMode<M>> = {},
> extends BasePrefabBucket<M, SpecForMode<M>, PrefabUnionForMode<M>, Specs> {
    constructor(mode: M) {
        const parsers = mode === '3d' ? parsers3d : parsers2d;
        super(mode, parsers as any);
    }

    /**
     * Add a spec. Chains return the subclass type so the bucket variable's
     * static type accumulates id→spec mappings, enabling `get` to narrow.
     */
    add<const S extends SpecForMode<M>>(
        spec: S,
    ): PrefabBucket<M, Specs & { [K in S['id']]: S }> {
        return super.add(spec) as unknown as PrefabBucket<M, Specs & { [K in S['id']]: S }>;
    }

    addAll<const Ss extends readonly SpecForMode<M>[]>(
        specs: Ss,
    ): PrefabBucket<M, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }> {
        return super.addAll(specs) as unknown as PrefabBucket<
            M,
            Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }
        >;
    }

    /**
     * Return the parsed prefab variant for this id. Narrow type — `get('minion')`
     * returns `GltfPrefab` (with `.animations`, `.jointCount`), not the union.
     *
     * Accepts any string at runtime but autocompletes known ids.
     */
    get<
        K extends keyof Specs & string,
        R = PrefabFor<Specs[K]>,
    >(id: StringOr<K>): R {
        return super.get(id as K) as R;
    }
}

/** Convenience aliases for explicit mode typing (e.g. function params). */
export type PrefabBucket2D<Specs extends Record<string, Prefab2DSpec> = {}> = PrefabBucket<'2d', Specs>;
export type PrefabBucket3D<Specs extends Record<string, Prefab3DSpec> = {}> = PrefabBucket<'3d', Specs>;

export type {
    GltfPrefab,
    GltfSpec,
    GridPrefab,
    GridSpec,
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
    PrefabFor,
    SpritesheetPrefab,
    SpritesheetSpec,
} from './specs';

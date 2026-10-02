/**
 * PrefabBucket — typed registry of reusable spawn templates.
 *
 * Accepts 2D or 3D prefab specs and returns parsed prefabs. Backends
 * (e.g. `@murow/webgpu`) read these at init() to size GPU buffers.
 *
 * ```ts
 * const prefabs = new PrefabBucket('3d')
 *   .add({ type: 'gltf', id: 'minion', src: '/minion.glb' })
 *   .add({ type: 'cube',  id: 'box',   size: 1 });
 *
 * await prefabs.load();
 * prefabs.get('minion');  // GltfPrefab — .animations, .jointCount, …
 * ```
 */

import { Bucket, type BucketBaseEvents, type BucketSpecBase } from '../bucket/bucket';
import { parsers2d, parsers3d } from './utility/parsers';
import { EventSystem } from '../../../core/events';
import type { PrefabBucketEvents, SpecWithHitbox } from './utility/index';
import type { HitboxLibrary } from '../../../core/hitbox/hitbox-library';
import type {
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
} from './utility/specs';

// ——— Helpers ———

type SpecForMode<M extends '2d' | '3d'> =
    M extends '3d' ? Prefab3DSpec : Prefab2DSpec;

type PrefabUnionForMode<M extends '2d' | '3d'> =
    M extends '3d' ? Prefab3D : Prefab2D;

/** A spec union with `hitbox` constrained to the registered hitbox names. */
type PrefabSpecFor<SpecUnion extends BucketSpecBase, HB extends string> =
    SpecWithHitbox<SpecUnion, HB> & BucketSpecBase;

// ——— PrefabBucket ———

/**
 * Registry of prefab specs and their parsed variants. The bucket tracks
 * the mapping of spec `id` strings to their parsed prefab types, so
 * `get` narrows to the correct prefab variant.
 *
 * @typeParam M  `'3d'` (default) or `'2d'` — controls the spec/prefab union.
 * @typeParam Specs  Accumulated spec record, auto-inferred from `.add()` calls.
 * @typeParam SpecUnion  The spec union `add()` accepts. Defaults to the full
 *                       spec union for the mode. Can be narrowed (e.g. by
 *                       AssetBucket) so that `PlaneSpec.texture` autocompletes
 *                       to known texture ids.
 * @typeParam HB  Hitbox names registered via `hitboxes()`, narrowing the
 *                `hitbox` field of `add()`. Defaults to `never` (any string).
 */
export class PrefabBucket<
    M extends '2d' | '3d' = '3d',
    Specs extends Record<string, BucketSpecBase> = {},
    SpecUnion extends BucketSpecBase = SpecForMode<M>,
    HB extends string = never,
> extends Bucket<PrefabSpecFor<SpecUnion, HB>, PrefabUnionForMode<M>, Specs, PrefabBucketEvents> {

    private _hitboxLibrary: HitboxLibrary<M> | null = null;

    constructor(mode: M) {
        const parsers = mode === '3d' ? parsers3d : parsers2d;
        const events = new EventSystem<[...BucketBaseEvents, ...PrefabBucketEvents]>({
            events: ['loading', 'load-complete', 'clips-changed'],
        });
        super(parsers as unknown as any, events);
    }

    /** Register a hitbox library. Chains; its names narrow the `hitbox` field on `add`. */
    hitboxes<N extends string>(
        library: HitboxLibrary<M, N>,
    ): PrefabBucket<M, Specs, SpecUnion, N> {
        this._hitboxLibrary = library as HitboxLibrary<M>;
        return this as unknown as PrefabBucket<M, Specs, SpecUnion, N>;
    }

    /** The registered hitbox library, or null. */
    get hitboxLibrary(): HitboxLibrary<M> | null {
        return this._hitboxLibrary;
    }

    /**
     * Add a single spec. Overridden to return the subclass type so chaining
     * through AssetBucket callbacks accumulates specs for narrowed `get()`.
     */
    add<const S extends PrefabSpecFor<SpecUnion, HB>>(
        spec: S,
    ): PrefabBucket<M, Specs & Record<S['id'], S>, SpecUnion, HB> {
        return super.add(spec) as unknown as PrefabBucket<M, Specs & Record<S['id'], S>, SpecUnion, HB>;
    }

    addAll<const Ss extends readonly PrefabSpecFor<SpecUnion, HB>[]>(
        specs: Ss,
    ): PrefabBucket<M, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }, SpecUnion, HB> {
        return super.addAll(specs) as unknown as PrefabBucket<
            M,
            Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> },
            SpecUnion,
            HB
        >;
    }
}

/** Convenience aliases. */
export type PrefabBucket2D<
    Specs extends Record<string, BucketSpecBase> = {},
    SpecUnion extends BucketSpecBase = Prefab2DSpec,
    HB extends string = never,
> = PrefabBucket<'2d', Specs, SpecUnion, HB>;

export type PrefabBucket3D<
    Specs extends Record<string, BucketSpecBase> = {},
    SpecUnion extends BucketSpecBase = Prefab3DSpec,
    HB extends string = never,
> = PrefabBucket<'3d', Specs, SpecUnion, HB>;

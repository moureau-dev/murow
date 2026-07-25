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
import { parsers2d, parsers3d } from '../../prefab-bucket/parsers';
import { EventSystem } from '../../../core/events';
import type { PrefabBucketEvents } from '../../prefab-bucket/index';
import type {
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
} from '../../prefab-bucket/specs';

// ——— Helpers ———

type SpecForMode<M extends '2d' | '3d'> =
    M extends '3d' ? Prefab3DSpec : Prefab2DSpec;

type PrefabUnionForMode<M extends '2d' | '3d'> =
    M extends '3d' ? Prefab3D : Prefab2D;

/** Additional events the PrefabBucket emits on top of BucketBaseEvents. */
type PrefabEvents = [
    ['clips-changed', { prefabId: string; added: readonly string[]; removed: readonly string[] }],
];

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
 */
export class PrefabBucket<
    M extends '2d' | '3d' = '3d',
    Specs extends Record<string, BucketSpecBase> = {},
    SpecUnion extends BucketSpecBase = SpecForMode<M>,
> extends Bucket<SpecUnion, PrefabUnionForMode<M>, Specs, PrefabEvents> {

    constructor(mode: M) {
        const parsers = mode === '3d' ? parsers3d : parsers2d;
        const events = new EventSystem<[...BucketBaseEvents, ...PrefabEvents]>({
            events: ['loading', 'load-complete', 'clips-changed'],
        });
        super(parsers as unknown as any, events);
    }

    /**
     * Add a single spec. Overridden to return the subclass type so chaining
     * through AssetBucket callbacks accumulates specs for narrowed `get()`.
     */
    add<const S extends SpecUnion>(
        spec: S,
    ): PrefabBucket<M, Specs & Record<S['id'], S>, SpecUnion> {
        return super.add(spec) as unknown as PrefabBucket<M, Specs & Record<S['id'], S>, SpecUnion>;
    }
}

/** Convenience aliases. */
export type PrefabBucket2D<
    Specs extends Record<string, BucketSpecBase> = {},
    SpecUnion extends BucketSpecBase = Prefab2DSpec,
> = PrefabBucket<'2d', Specs, SpecUnion>;

export type PrefabBucket3D<
    Specs extends Record<string, BucketSpecBase> = {},
    SpecUnion extends BucketSpecBase = Prefab3DSpec,
> = PrefabBucket<'3d', Specs, SpecUnion>;

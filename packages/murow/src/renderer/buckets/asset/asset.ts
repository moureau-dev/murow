/**
 * AssetBucket — combines a TextureBucket and PrefabBucket under one roof.
 *
 * Both buckets load in parallel via a single `await assets.load()` call.
 * `assets.textures` and `assets.prefabs` are callable accessors — use them
 * as properties for the inner bucket, or call them with a callback to
 * configure. When textures are declared first, `PlaneSpec.texture`
 * autocompletes to those texture ids.
 *
 * ```ts
 * const assets = new AssetBucket('3d')
 *   .textures(({ bucket }) => bucket
 *     .add({ type: 'texture', id: 'brick', src: '/brick.png' })
 *     .add({ type: 'texture', id: 'wood',  src: '/wood.png' })
 *   )
 *   .prefabs(({ bucket }) => bucket
 *     .add({ type: 'cube',  id: 'box',  size: 1 })
 *     .add({ type: 'plane', id: 'wall', width: 4, height: 3, texture: 'brick' })
 *   );
 *
 * await assets.load();
 *
 * assets.textures.get('brick');   // TexturePrefab — property access
 * assets.prefabs.get('wall');     // PlanePrefab   — property access
 * assets.loaded;                  // true
 * ```
 */

import type {
    PlaneSpec,
    Prefab2DSpec,
    Prefab3DSpec,
    TextureSpec,
} from '../../prefab-bucket/specs';
import { PrefabBucket, type PrefabBucket2D, type PrefabBucket3D } from '../prefab/prefab';
import { TextureBucket } from '../texture/texture';
import { type StringOr } from '../bucket/bucket';

// ——— Helpers ———

type SpecForMode<M extends '2d' | '3d'> =
    M extends '3d' ? Prefab3DSpec : Prefab2DSpec;

/** A spec from the union whose `texture` field is narrowed to known texture ids. */
type TextureAwareSpec<TexId extends string> =
    Omit<PlaneSpec, 'texture'> & { readonly texture?: StringOr<TexId> };

/** The full prefab spec union with relevant specs narrowed by `TexId`. */
type PrefabSpecWithTexIds<M extends '2d' | '3d', TexId extends string> =
    Exclude<SpecForMode<M>, PlaneSpec> | TextureAwareSpec<TexId>;

/** Callable accessor signature for `asset.textures`. */
type TexturesCallable<TexSpecs extends Record<string, TextureSpec>, M extends '2d' | '3d', PrefabSpecs extends Record<string, SpecForMode<M>>> = {
    <S extends Record<string, TextureSpec>>(
        cb: (ctx: { bucket: TextureBucket }) => TextureBucket<S>,
    ): AssetBucket<M, S, PrefabSpecs>;
};

/** Callable accessor signature for `asset.prefabs`. */
type PrefabsCallable<TexSpecs extends Record<string, TextureSpec>, M extends '2d' | '3d', PrefabSpecs extends Record<string, SpecForMode<M>>> = {
    <S extends Record<string, any>>(
        cb: (ctx: { bucket: PrefabBucket<M, PrefabSpecs, PrefabSpecWithTexIds<M, keyof TexSpecs & string>> }) => PrefabBucket<M, S, PrefabSpecWithTexIds<M, keyof TexSpecs & string>>,
    ): AssetBucket<M, TexSpecs, S>;
};

// ——— AssetBucket ———

/**
 * Combines a `TextureBucket` and a `PrefabBucket` under a single load()
 * lifecycle. The `textures` and `prefabs` accessors are callable — use
 * them as properties to access the inner bucket, or call them with a
 * callback to configure.
 *
 * @typeParam M  `'3d'` (default) or `'2d'` — controls which prefab spec
 *               union the internal PrefabBucket accepts.
 * @typeParam TexSpecs  Accumulated texture spec record (auto-inferred from calls).
 * @typeParam PrefabSpecs  Accumulated prefab spec record (auto-inferred from calls).
 */
export class AssetBucket<
    M extends '2d' | '3d' = '3d',
    TexSpecs extends Record<string, TextureSpec> = {},
    PrefabSpecs extends Record<string, SpecForMode<M>> = {},
> {
    #textures: TextureBucket<TexSpecs>;
    #prefabs: PrefabBucket<M, PrefabSpecs>;

    /**
     * The textures accessor. Use as a property (`assets.textures.add(...)` /
     * `assets.textures.get('brick')`) or call with a callback to configure
     * (`assets.textures(({ bucket }) => bucket.add(...))`).
     */
    readonly textures: TextureBucket<TexSpecs> & TexturesCallable<TexSpecs, M, PrefabSpecs>;

    /**
     * The prefabs accessor. Use as a property (`assets.prefabs.add(...)` /
     * `assets.prefabs.get('wall')`) or call with a callback to configure
     * (`assets.prefabs(({ bucket }) => bucket.add(...))`).
     */
    readonly prefabs: PrefabBucket<M, PrefabSpecs> & PrefabsCallable<TexSpecs, M, PrefabSpecs>;

    constructor(mode: M) {
        const texBucket = new TextureBucket() as unknown as TextureBucket<TexSpecs>;
        const prefsBucket = new PrefabBucket(mode) as unknown as PrefabBucket<M, PrefabSpecs>;

        this.#textures = texBucket;
        this.#prefabs = prefsBucket;

        // Build a callable proxy for textures
        const texFn = ((cb?: (ctx: { bucket: TextureBucket }) => TextureBucket<any>) => {
            if (cb) {
                cb({ bucket: texBucket as unknown as TextureBucket });
                return this as unknown as AssetBucket<M, TexSpecs, PrefabSpecs>;
            }
            throw new TypeError('AssetBucket.textures: expected a callback function');
        }) as unknown as TextureBucket<TexSpecs> & TexturesCallable<TexSpecs, M, PrefabSpecs>;

        this.textures = new Proxy(texFn, {
            get(target, prop) {
                if (prop in target) return (target as any)[prop];
                const val = (texBucket as any)[prop];
                return typeof val === 'function' ? val.bind(texBucket) : val;
            },
        }) as any;

        // Same for prefabs, casting to the narrowed SpecUnion type
        const prefsFn = ((cb?: (ctx: { bucket: PrefabBucket<M, PrefabSpecs, PrefabSpecWithTexIds<M, keyof TexSpecs & string>> }) => PrefabBucket<M, any, PrefabSpecWithTexIds<M, keyof TexSpecs & string>>) => {
            if (cb) {
                this.#prefabs = cb({ bucket: this.#prefabs as unknown as PrefabBucket<M, PrefabSpecs, PrefabSpecWithTexIds<M, keyof TexSpecs & string>> }) as unknown as PrefabBucket<M, PrefabSpecs>;
                return this as unknown as AssetBucket<M, TexSpecs, PrefabSpecs>;
            }
            throw new TypeError('AssetBucket.prefabs: expected a callback function');
        }) as unknown as PrefabBucket<M, PrefabSpecs> & PrefabsCallable<TexSpecs, M, PrefabSpecs>;

        this.prefabs = new Proxy(prefsFn, {
            get(target, prop) {
                if (prop in target) return (target as any)[prop];
                const val = (prefsBucket as any)[prop];
                return typeof val === 'function' ? val.bind(prefsBucket) : val;
            },
        }) as any;
    }

    /**
     * Load all registered assets. Both the texture and prefab buckets
     * are loaded in parallel. Idempotent — safe to call multiple times.
     */
    async load(): Promise<void> {
        await Promise.all([
            this.#textures.load(),
            this.#prefabs.load(),
        ]);
    }

    /** True once `load()` has resolved on both inner buckets. */
    get loaded(): boolean {
        return this.#textures.loaded && this.#prefabs.loaded;
    }
}

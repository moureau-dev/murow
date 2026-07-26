/**
 * Buckets — typed registries of loadable resources.
 *
 * - `Bucket` — generic base class (can be extended for custom resource types)
 * - `TextureBucket` — loads images by id, returns `TexturePrefab`
 * - `PrefabBucket` — loads 2D/3D spawnable prefabs, returns `Prefab3D` / `Prefab2D`
 * - `AssetBucket` — combines textures + prefabs under one load() lifecycle
 *
 * ```ts
 * const assets = new AssetBucket('3d')
 *   .textures(({ bucket }) => bucket
 *     .add({ type: 'texture', id: 'brick', src: '/brick.png' })
 *   )
 *   .prefabs(({ bucket }) => bucket
 *     .add({ type: 'plane', id: 'wall', texture: 'brick' })
 *   );
 *
 * await assets.load();
 * ```
 */

export { Bucket, type BucketPrefabBase, type BucketSpecBase, type StringOr, type BucketBaseEvents } from './bucket';

export { TextureBucket } from './texture';

export {
    PrefabBucket,
    type PrefabBucket2D,
    type PrefabBucket3D,
} from './prefab';

export { AssetBucket } from './asset';

// Re-export spec types so consumers don't need to dig into prefab-bucket/.
export type {
    CompositePrefab,
    CompositeSpec,
    CubePrefab,
    CubeSpec,
    GltfPrefab,
    GltfSpec,
    GridPrefab,
    GridSpec,
    PartOffset,
    PlanePrefab,
    PlaneSpec,
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
    PrefabFor,
    SpritesheetPrefab,
    SpritesheetSpec,
    TexturePrefab,
    TextureSpec,
} from '../prefab-bucket/specs';

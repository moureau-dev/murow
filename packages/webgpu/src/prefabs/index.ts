/**
 * createPrefabBucket — entry point for both 2D and 3D prefab buckets.
 *
 * Pass `'2d'` or `'3d'` to pick the spec/prefab universe. The bucket carries
 * the right parsers internally; user code only sees `add`, `addAll`, `load`, `get`.
 *
 * ```ts
 * const bucket = createPrefabBucket('3d')
 *     .add({ type: 'gltf', id: 'minion', url: '/minion.glb' })
 *     .add({ type: 'grid', id: 'floor', size: 20, step: 0.33, lineWidth: 0.001 });
 *
 * await bucket.load();
 * ```
 */

import { PrefabBucket } from 'murow/renderer';
import { parsers2d, parsers3d } from './parsers';
import type { Prefab2D, Prefab2DSpec, Prefab3D, Prefab3DSpec } from './specs';

export type PrefabBucket2D<Ids extends string = never> =
    PrefabBucket<'2d', Prefab2DSpec, Prefab2D, Ids>;
export type PrefabBucket3D<Ids extends string = never> =
    PrefabBucket<'3d', Prefab3DSpec, Prefab3D, Ids>;

export function createPrefabBucket(mode: '2d'): PrefabBucket2D;
export function createPrefabBucket(mode: '3d'): PrefabBucket3D;
export function createPrefabBucket(mode: '2d' | '3d'): PrefabBucket2D | PrefabBucket3D {
    if (mode === '2d') {
        return new PrefabBucket<'2d', Prefab2DSpec, Prefab2D>('2d', parsers2d);
    }
    return new PrefabBucket<'3d', Prefab3DSpec, Prefab3D>('3d', parsers3d);
}

export type {
    GltfPrefab,
    GltfSpec,
    GridPrefab,
    GridSpec,
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
    SpritesheetPrefab,
    SpritesheetSpec,
} from './specs';

/**
 * Per-prefab GPU handle helpers, populated by the renderer at `init()` time
 * when a PrefabBucket is supplied.
 */
import type { ModelHandle, GltfModel } from '../../types';
import type { Prefab3D } from 'murow/renderer';

const GPU_HANDLE = Symbol('murow.gpuHandle');

/** True iff `value` is a Prefab3D (returned from `bucket.get(...)`). */
export function isPrefab3D(value: ModelHandle | GltfModel | Prefab3D | string): value is Prefab3D {
    if (typeof value === 'string' || value === undefined) return false;
    const t = (value as Prefab3D).type;
    return t === 'gltf' || t === 'grid' || t === 'cube' || t === 'composite' || t === 'plane';
}

/** Attach the uploaded GPU handle to a prefab. */
export function setPrefabHandle(prefab: Prefab3D, handle: ModelHandle | GltfModel): void {
    (prefab as unknown as Record<symbol, ModelHandle | GltfModel>)[GPU_HANDLE] = handle;
}

/**
 * Look up the GPU handle attached to a prefab by its renderer. Used by
 * `instances.add({ prefab: bucket.get('foo') })` to resolve the prefab back to
 * the renderer's internal handle. Throws if the prefab has not been uploaded.
 */
export function resolvePrefabHandle(prefab: Prefab3D): ModelHandle | GltfModel {
    const h = (prefab as unknown as Record<symbol, ModelHandle | GltfModel>)[GPU_HANDLE];
    if (!h) {
        throw new Error(
            `Prefab '${prefab.id}' has no GPU handle; has the renderer's init() been called with this bucket?`,
        );
    }
    return h;
}

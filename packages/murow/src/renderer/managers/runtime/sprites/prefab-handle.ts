/**
 * Per-prefab GPU handle helpers for the 2D renderer, populated at `init()` time
 * when a PrefabBucket is supplied.
 */
import type { SpritesheetHandle, Prefab2D } from 'murow/renderer';

const PREFAB_GPU_HANDLE = Symbol('murow.prefabGpuHandle');

/** True iff `value` is a Prefab2D (returned from `bucket.get(...)`). */
export function isPrefab2D(value: SpritesheetHandle | Prefab2D): value is Prefab2D {
    return (value as Prefab2D).type === 'spritesheet';
}

/** Attach the uploaded GPU handle to a prefab. */
export function setPrefab2DHandle(prefab: Prefab2D, handle: SpritesheetHandle): void {
    (prefab as unknown as Record<symbol, SpritesheetHandle>)[PREFAB_GPU_HANDLE] = handle;
}

/**
 * Look up the GPU handle attached to a prefab by its renderer. Throws if the
 * prefab has not been uploaded.
 */
export function resolveSpritePrefabHandle(prefab: Prefab2D): SpritesheetHandle {
    const h = (prefab as unknown as Record<symbol, SpritesheetHandle>)[PREFAB_GPU_HANDLE];
    if (!h) {
        throw new Error(
            `Prefab '${prefab.id}' has no GPU handle — has the renderer's init() been called with this bucket?`,
        );
    }
    return h;
}

/**
 * Bridges the bucket's `clips-changed` events to per-skin resync work in the
 * renderer. The renderer registers `prefabId → skinIndex` at upload time;
 * subsequent events flag affected skins in a pending set the renderer drains
 * each frame.
 */
import type { PrefabBucket } from 'murow';

export class GltfClipResyncCoordinator {
    private readonly skinIndexByPrefabId = new Map<string, number>();
    private readonly _pending = new Set<number>();

    constructor(private bucket: PrefabBucket) {
        this.bucket.events.on('clips-changed', ({ prefabId }) => {
            const skinIndex = this.skinIndexByPrefabId.get(prefabId);
            if (skinIndex !== undefined) this._pending.add(skinIndex);
        });
    }

    /** Map a prefab id to its index in the renderer's `skinnedModels` list. */
    registerSkin(prefabId: string, skinIndex: number): void {
        this.skinIndexByPrefabId.set(prefabId, skinIndex);
    }

    /** Skin indices whose clip set has changed since the last `clear()`. */
    get pending(): ReadonlySet<number> {
        return this._pending;
    }

    clear(): void {
        this._pending.clear();
    }

    /** Unsubscribe from the bucket and clear internal state. */
    dispose(): void {
        this.bucket.events.clear('clips-changed');
        this.skinIndexByPrefabId.clear();
        this._pending.clear();
    }
}

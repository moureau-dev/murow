/**
 * Bridges the bucket's `clips-changed` events to per-skin resync work in the
 * renderer. The renderer registers `prefabId → skinIndex` at upload time;
 * subsequent events flag affected skins in a `SlotSet` the renderer drains each
 * frame.
 */
import { SlotSet } from 'murow/core/slot-map';
import type { PrefabBucket } from 'murow';

export class GltfClipResyncCoordinator {
    /** Registered prefab ids and their skin indices, dense for [0, skinCount). */
    private readonly prefabIds: string[];
    private readonly skinIndices: Int32Array;
    private skinCount = 0;

    /** Skin indices whose clip set changed since the last `clear()`. */
    private readonly _pending: SlotSet;

    constructor(
        private bucket: PrefabBucket,
        maxSkins: number,
    ) {
        this.prefabIds = new Array(maxSkins).fill(null);
        this.skinIndices = new Int32Array(maxSkins);
        this._pending = new SlotSet(maxSkins);

        this.bucket.events.on('clips-changed', ({ prefabId }) => this.onClipsChanged(prefabId));
    }

    /** Map a prefab id to its index in the renderer's `skinnedModels` list. */
    registerSkin(prefabId: string, skinIndex: number): void {
        this.prefabIds[this.skinCount] = prefabId;
        this.skinIndices[this.skinCount] = skinIndex;
        this.skinCount++;
    }

    private onClipsChanged(prefabId: string): void {
        for (let i = 0; i < this.skinCount; i++) {
            if (this.prefabIds[i] !== prefabId) continue;
            this._pending.add(this.skinIndices[i]!);
            return;
        }
    }

    /** Skin indices whose clip set has changed. */
    get pending(): SlotSet {
        return this._pending;
    }

    clear(): void {
        this._pending.clear();
    }

    /** Unsubscribe from the bucket and clear internal state. */
    dispose(): void {
        this.bucket.events.clear('clips-changed');
        this._pending.clear();
    }
}

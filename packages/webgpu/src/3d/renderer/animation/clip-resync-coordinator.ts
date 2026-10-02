/**
 * Bridges the bucket's `clips-changed` events to per-skin resync work in the
 * renderer. The renderer registers `prefabId → skinIndex` at upload time;
 * subsequent events flag affected skins in a dense pending list the renderer
 * drains each frame. No hash tables: registration is a dense array and event
 * lookup is a linear scan (skinned-prefab counts are tiny).
 */
import type { PrefabBucket } from 'murow';

export class GltfClipResyncCoordinator {
    /** Registered prefab ids and their skin indices, dense for [0, skinCount). */
    private readonly prefabIds: string[];
    private readonly skinIndices: Int32Array;
    private skinCount = 0;

    /** Dense pending skin indices and dedup flags. */
    private readonly _pendingIndices: Int32Array;
    private readonly pendingFlags: Uint8Array;
    private _pendingCount = 0;

    constructor(
        private bucket: PrefabBucket,
        maxSkins: number,
    ) {
        this.prefabIds = new Array(maxSkins).fill(null);
        this.skinIndices = new Int32Array(maxSkins);
        this._pendingIndices = new Int32Array(maxSkins);
        this.pendingFlags = new Uint8Array(maxSkins);

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
            const skinIndex = this.skinIndices[i]!;
            if (this.pendingFlags[skinIndex] === 0) {
                this.pendingFlags[skinIndex] = 1;
                this._pendingIndices[this._pendingCount++] = skinIndex;
            }
            return;
        }
    }

    /** Skin indices whose clip set has changed, dense for [0, pendingCount). */
    get pendingIndices(): Int32Array {
        return this._pendingIndices;
    }

    get pendingCount(): number {
        return this._pendingCount;
    }

    clear(): void {
        for (let i = 0; i < this._pendingCount; i++) {
            this.pendingFlags[this._pendingIndices[i]!] = 0;
        }
        this._pendingCount = 0;
    }

    /** Unsubscribe from the bucket and clear internal state. */
    dispose(): void {
        this.bucket.events.clear('clips-changed');
        this.clear();
    }
}

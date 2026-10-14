/** An instance handle the occlusion tracker can watch. */
export interface OcclusionTrackable {
    readonly slot: number;
    readonly skinned?: boolean;
    readonly destroyed?: boolean;
}

/** Cached, synchronous occlusion state for a fixed set of handles. */
export interface OcclusionTracker {
    /** Last known occlusion (true = hidden). Refreshed by the renderer. */
    isOccluded(handle: OcclusionTrackable): boolean;
    readonly handles: readonly OcclusionTrackable[];
    release(): void;
}

/** Per-slot visibility the tracker applies: `1` = drawn, `0` = occluded. */
export interface OcclusionVisibility {
    static: Uint32Array;
    skinned: Uint32Array;
}

/**
 * Holds the last occlusion readback for a set of handles. The renderer swaps in
 * a fresh readback with {@link apply}; callers read {@link isOccluded} on the hot
 * path. Keeps only the latest arrays, so lookups stay allocation-free by slot.
 */
export class OcclusionTrackerImpl implements OcclusionTracker {
    readonly handles: readonly OcclusionTrackable[];
    private visible: OcclusionVisibility | null = null;

    constructor(handles: readonly OcclusionTrackable[], private readonly onRelease: () => void = () => {}) {
        this.handles = handles.slice();
    }

    isOccluded(handle: OcclusionTrackable): boolean {
        if (handle.destroyed || this.visible === null) return false;
        const arr = handle.skinned ? this.visible.skinned : this.visible.static;
        return arr[handle.slot >>> 0] === 0;
    }

    apply(vis: OcclusionVisibility): void {
        this.visible = vis;
    }

    release(): void {
        this.onRelease();
    }
}

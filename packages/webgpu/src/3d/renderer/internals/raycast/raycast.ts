import type { InputSnapshot } from 'murow/core/input';
import { HitBuffer, type BufferedHit } from 'murow/core/raycast';
import {
    Raycast,
    RaycastMemo,
    type RaycastHit,
    type RaycastOptions,
} from 'murow/renderer';

import type { MeshInstanceHandle } from '../../types';
import type { WebGPU3DRenderer } from '../../renderer';

type Point = [number, number, number];
type Hit = RaycastHit<MeshInstanceHandle, Point>;
type Opts = RaycastOptions<MeshInstanceHandle>;

export type RaycastState = HitBuffer<MeshInstanceHandle, Point>;

export class WebGPURaycast3D extends Raycast<MeshInstanceHandle, Point> {
    readonly state: RaycastState = new HitBuffer<MeshInstanceHandle, Point>(3);

    private resultBuffer: BufferedHit<MeshInstanceHandle, Point>[] = [];
    private readonly memos: WebGPURaycastMemo3D[] = [];

    constructor(private renderer: WebGPU3DRenderer) { super(); }

    update(input: InputSnapshot): void {
        this.state.reset();
        this.renderer._collectRaycastHitsInto(input.mouse.position.x, input.mouse.position.y, this.state);
        for (let i = 0; i < this.memos.length; i++) this.memos[i]!._invalidate();
    }

    /**
     * Nearest hit, or null. The returned object is pool-backed and valid
     * only until the next `update()` -- copy what you need, or use `memo`
     * for results that persist across frames.
     */
    hit(opts?: Opts): Hit | null {
        return this.state.nearest(opts?.filter, opts?.maxDistance ?? Infinity);
    }

    /**
     * All hits, nearest first. The array and its entries are reused across
     * calls and overwritten by the next `update()`; do not retain them.
     */
    hitAll(opts?: Opts): readonly Hit[] {
        this.state.collectInto(this.resultBuffer, opts?.filter, opts?.maxDistance ?? Infinity);
        return this.resultBuffer;
    }

    memo(opts: Opts): WebGPURaycastMemo3D {
        const m = new WebGPURaycastMemo3D(this.state, opts, () => this.removeMemo(m));
        m._index = this.memos.length;
        this.memos.push(m);
        return m;
    }

    private removeMemo(m: WebGPURaycastMemo3D): void {
        const i = m._index;
        if (i < 0 || i >= this.memos.length || this.memos[i] !== m) return;
        const last = this.memos.pop()!;
        if (last !== m) {
            this.memos[i] = last;
            last._index = i;
        }
        m._index = -1;
    }

    clearMemos(): void {
        for (let i = 0; i < this.memos.length; i++) this.memos[i]!._detach();
        this.memos.length = 0;
    }
}

export class WebGPURaycastMemo3D extends RaycastMemo<MeshInstanceHandle, Point> {
    /** Position in the renderer's dense memo list, or -1 when not attached. */
    _index = -1;
    private dirty = true;
    private detached = false;
    private cached: BufferedHit<MeshInstanceHandle, Point>[] = [];

    constructor(
        private state: RaycastState,
        private opts: Opts,
        private onDispose: () => void,
    ) { super(); }

    get hits(): readonly Hit[] {
        if (this.detached) return this.cached;
        if (this.dirty) {
            this.state.collectInto(this.cached, this.opts.filter, this.opts.maxDistance ?? Infinity);
            this.dirty = false;
        }
        return this.cached;
    }

    get first(): Hit | null {
        const arr = this.hits;
        return arr.length > 0 ? arr[0] : null;
    }

    dispose(): void {
        if (this.detached) return;
        this.onDispose();
        this._detach();
    }

    _invalidate(): void {
        this.dirty = true;
    }

    _detach(): void {
        this.detached = true;
        this.cached.length = 0;
    }
}

import type { InputSnapshot } from 'murow/core/input';
import { HitBuffer, type BufferedHit } from 'murow/core/raycast';
import {
    Raycast,
    RaycastMemo,
    type RaycastHit,
    type RaycastOptions,
} from 'murow/renderer';

import type { SpriteHandle } from 'murow/renderer';
import type { WebGPU2DRenderer } from './renderer';

type Point = [number, number];
type Hit = RaycastHit<SpriteHandle, Point>;
type Opts = RaycastOptions<SpriteHandle>;

export type RaycastState2D = HitBuffer<SpriteHandle, Point>;

export class WebGPURaycast2D extends Raycast<SpriteHandle, Point> {
    readonly state: RaycastState2D = new HitBuffer<SpriteHandle, Point>(2);

    private resultBuffer: BufferedHit<SpriteHandle, Point>[] = [];
    private memos = new Set<WebGPURaycastMemo2D>();

    constructor(private renderer: WebGPU2DRenderer) { super(); }

    update(input: InputSnapshot): void {
        this.state.reset();
        this.renderer._collectRaycastHitsInto(input.mouse.position.x, input.mouse.position.y, this.state);
        for (const m of this.memos) m._invalidate();
    }

    /**
     * Topmost sprite under the cursor, or null. The returned object is
     * pool-backed and valid only until the next `update()` -- copy what
     * you need, or use `memo` for results that persist across frames.
     */
    hit(opts?: Opts): Hit | null {
        return this.state.nearest(opts?.filter, opts?.maxDistance ?? Infinity);
    }

    /**
     * Every sprite under the cursor, topmost first. The array and its
     * entries are reused and overwritten by the next `update()`.
     */
    hitAll(opts?: Opts): readonly Hit[] {
        this.state.collectInto(this.resultBuffer, opts?.filter, opts?.maxDistance ?? Infinity);
        return this.resultBuffer;
    }

    memo(opts: Opts): WebGPURaycastMemo2D {
        const m = new WebGPURaycastMemo2D(this.state, opts, () => this.memos.delete(m));
        this.memos.add(m);
        return m;
    }

    clearMemos(): void {
        for (const m of this.memos) m._detach();
        this.memos.clear();
    }
}

export class WebGPURaycastMemo2D extends RaycastMemo<SpriteHandle, Point> {
    private dirty = true;
    private detached = false;
    private cached: BufferedHit<SpriteHandle, Point>[] = [];

    constructor(
        private state: RaycastState2D,
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

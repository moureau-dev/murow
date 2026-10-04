import type { AnyWgslData } from 'typegpu/data';
import { FreeList } from 'murow/core/free-list';

/**
 * A camera effect is a fullscreen pass applied after the scene renders. The
 * `CameraEffectSpec` union is the input shape (and what you serialize); a
 * `CameraEffect` flattens that shape onto an instance so you can hold a typed
 * reference and retune it directly:
 *
 * ```ts
 * const blur = new CameraEffect({ type: 'motionBlur', feedback: 0.6 });
 * blur.feedback = 0.3;
 * blur.enabled = false;
 * ```
 */
export type CameraEffectSpec =
    | { readonly type: 'vignette'; readonly strength?: number; readonly inner?: number; readonly outer?: number }
    | { readonly type: 'grade'; readonly saturation?: number; readonly contrast?: number; readonly brightness?: number }
    | { readonly type: 'grayscale' }
    | { readonly type: 'chromatic'; readonly amount?: number }
    | { readonly type: 'scanlines'; readonly intensity?: number; readonly frequency?: number; readonly speed?: number }
    | { readonly type: 'posterize'; readonly levels?: number }
    | { readonly type: 'motionBlur'; readonly feedback?: number }
    | CustomCameraEffectSpec;

/**
 * A user-authored fullscreen effect. The fragment receives `input.vUV` and can
 * sample `textures.src` with `textures.sampler`; it also has `material.<name>`
 * uniforms, `scene.time` / `scene.resolutionX/Y`, and `history`. Retune via
 * `effect.params`.
 */
export interface CustomCameraEffectSpec {
    readonly type: 'shader';
    readonly fragment: (input: { vUV: { x: number; y: number } }) => unknown;
    readonly uniforms?: Record<string, AnyWgslData>;
    readonly defaultUniforms?: Record<string, number | readonly number[]>;
}

export class CameraEffect {
    /** Stable slot id, assigned by the list. -1 while unattached. */
    id = -1;
    enabled = true;
    type!: CameraEffectSpec['type'];
    strength?: number;
    inner?: number;
    outer?: number;
    saturation?: number;
    contrast?: number;
    brightness?: number;
    amount?: number;
    intensity?: number;
    frequency?: number;
    speed?: number;
    levels?: number;
    feedback?: number;
    fragment?: CustomCameraEffectSpec['fragment'];
    uniforms?: CustomCameraEffectSpec['uniforms'];
    defaultUniforms?: CustomCameraEffectSpec['defaultUniforms'];
    /** Live uniform values for a custom (`shader`) effect. */
    params?: Record<string, number | readonly number[]>;

    constructor(spec: CameraEffectSpec) {
        Object.assign(this, spec);
        if (spec.type === 'shader') {
            this.params = { ...(spec.defaultUniforms ?? {}) };
        }
    }
}

/**
 * Ordered list of camera effects owned by `Camera3D`. `add` accepts a spec or an
 * existing effect and returns the effect; `set` replaces the chain in order. The
 * renderer applies the enabled entries each frame. Effect ids come from a
 * bounded `FreeList` so the renderer can index compiled resources by id.
 */
export class CameraEffectList implements Iterable<CameraEffect> {
    private readonly free: FreeList;
    private items: CameraEffect[] = [];

    /**
     * @param maxEffects Maximum live effects; bounds the effect-id pool and the
     * renderer's compiled-resource arrays. Default 20.
     */
    constructor(private readonly maxEffects: number = 20) {
        this.free = new FreeList(maxEffects);
    }

    add(spec: CameraEffectSpec | CameraEffect): CameraEffect {
        const effect = spec instanceof CameraEffect ? spec : new CameraEffect(spec);
        this.retain(effect);
        this.items.push(effect);
        return effect;
    }

    /** Replace the whole chain, preserving order. */
    set(effects: readonly (CameraEffectSpec | CameraEffect)[]): void {
        for (let i = 0; i < this.items.length; i++) this.release(this.items[i]!);
        const next: CameraEffect[] = new Array(effects.length);
        for (let i = 0; i < effects.length; i++) {
            const e = effects[i]!;
            const effect = e instanceof CameraEffect ? e : new CameraEffect(e);
            this.retain(effect);
            next[i] = effect;
        }
        this.items = next;
    }

    remove(effect: CameraEffect): void {
        const i = this.items.indexOf(effect);
        if (i < 0) return;
        this.items.splice(i, 1);
        this.release(effect);
    }

    clear(): void {
        for (let i = 0; i < this.items.length; i++) this.release(this.items[i]!);
        this.items.length = 0;
    }

    get count(): number {
        return this.items.length;
    }

    /** Alias kept for ergonomic `length` checks. */
    get length(): number {
        return this.items.length;
    }

    enableCount(): number {
        let n = 0;
        for (let i = 0; i < this.items.length; i++) if (this.items[i]!.enabled) n++;
        return n;
    }

    at(index: number): CameraEffect {
        return this.items[index]!;
    }

    [Symbol.iterator](): Iterator<CameraEffect> {
        return this.items[Symbol.iterator]();
    }

    private retain(effect: CameraEffect): void {
        const id = this.free.allocate();
        if (id === -1) throw new Error(`CameraEffectList: max ${this.maxEffects} effects reached`);
        effect.id = id;
    }

    private release(effect: CameraEffect): void {
        if (effect.id >= 0) {
            this.free.free(effect.id);
            effect.id = -1;
        }
    }
}

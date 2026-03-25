/**
 * SpriteAccessor — zero-allocation handle for reading/writing sprite data.
 * Backed directly by the renderer's Float32Arrays.
 */
import {
    DYNAMIC_FLOATS_PER_SPRITE,
    DYNAMIC_OFFSET_CURR_ROTATION,
    DYNAMIC_OFFSET_CURR_X,
    DYNAMIC_OFFSET_CURR_Y,
    DYNAMIC_OFFSET_PREV_ROTATION,
    DYNAMIC_OFFSET_PREV_X,
    DYNAMIC_OFFSET_PREV_Y,
    STATIC_FLOATS_PER_SPRITE,
    STATIC_OFFSET_FLIP_X,
    STATIC_OFFSET_FLIP_Y,
    STATIC_OFFSET_LAYER,
    STATIC_OFFSET_OPACITY,
    STATIC_OFFSET_SCALE_X,
    STATIC_OFFSET_SCALE_Y,
    STATIC_OFFSET_TINT_A,
    STATIC_OFFSET_TINT_B,
    STATIC_OFFSET_TINT_G,
    STATIC_OFFSET_TINT_R,
    STATIC_OFFSET_UV_MAX_X,
    STATIC_OFFSET_UV_MAX_Y,
    STATIC_OFFSET_UV_MIN_X,
    STATIC_OFFSET_UV_MIN_Y,
} from "../core/constants";
import type { SpriteHandle } from "murow";

export class SpriteAccessor implements SpriteHandle {
    private dynamicData: Float32Array;
    private staticData: Float32Array;
    private dynamicBase: number;
    private staticBase: number;
    private _slot: number;
    private _sheetId: number;
    private _onStaticDirty: () => void;

    constructor(
        dynamicData: Float32Array,
        staticData: Float32Array,
        slot: number,
        sheetId: number,
        onStaticDirty: () => void,
    ) {
        this.dynamicData = dynamicData;
        this.staticData = staticData;
        this._slot = slot;
        this._sheetId = sheetId;
        this.dynamicBase = slot * DYNAMIC_FLOATS_PER_SPRITE;
        this.staticBase = slot * STATIC_FLOATS_PER_SPRITE;
        this._onStaticDirty = onStaticDirty;
    }

    get slot(): number { return this._slot; }
    get sheetId(): number { return this._sheetId; }

    // --- Dynamic properties (updated every tick) ---

    get x(): number { return this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_CURR_X]; }
    set x(v: number) { this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_CURR_X] = v; }

    get y(): number { return this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_CURR_Y]; }
    set y(v: number) { this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_CURR_Y] = v; }

    get prevX(): number { return this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_PREV_X]; }
    get prevY(): number { return this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_PREV_Y]; }

    get rotation(): number { return this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_CURR_ROTATION]; }
    set rotation(v: number) { this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_CURR_ROTATION] = v; }

    get prevRotation(): number { return this.dynamicData[this.dynamicBase + DYNAMIC_OFFSET_PREV_ROTATION]; }

    /**
     * Store current position/rotation as previous (called before tick).
     */
    storePrevious(): void {
        const d = this.dynamicData;
        const b = this.dynamicBase;
        d[b + DYNAMIC_OFFSET_PREV_X] = d[b + DYNAMIC_OFFSET_CURR_X];
        d[b + DYNAMIC_OFFSET_PREV_Y] = d[b + DYNAMIC_OFFSET_CURR_Y];
        d[b + DYNAMIC_OFFSET_PREV_ROTATION] = d[b + DYNAMIC_OFFSET_CURR_ROTATION];
    }

    // --- Static properties (rarely change, trigger dirty flag) ---

    get scaleX(): number { return this.staticData[this.staticBase + STATIC_OFFSET_SCALE_X]; }
    set scaleX(v: number) { this.staticData[this.staticBase + STATIC_OFFSET_SCALE_X] = v; this._onStaticDirty(); }

    get scaleY(): number { return this.staticData[this.staticBase + STATIC_OFFSET_SCALE_Y]; }
    set scaleY(v: number) { this.staticData[this.staticBase + STATIC_OFFSET_SCALE_Y] = v; this._onStaticDirty(); }

    get layer(): number { return this.staticData[this.staticBase + STATIC_OFFSET_LAYER]; }
    set layer(v: number) { this.staticData[this.staticBase + STATIC_OFFSET_LAYER] = v; this._onStaticDirty(); }

    get flipX(): boolean { return this.staticData[this.staticBase + STATIC_OFFSET_FLIP_X] !== 0; }
    set flipX(v: boolean) { this.staticData[this.staticBase + STATIC_OFFSET_FLIP_X] = v ? 1 : 0; this._onStaticDirty(); }

    get flipY(): boolean { return this.staticData[this.staticBase + STATIC_OFFSET_FLIP_Y] !== 0; }
    set flipY(v: boolean) { this.staticData[this.staticBase + STATIC_OFFSET_FLIP_Y] = v ? 1 : 0; this._onStaticDirty(); }

    get opacity(): number { return this.staticData[this.staticBase + STATIC_OFFSET_OPACITY]; }
    set opacity(v: number) { this.staticData[this.staticBase + STATIC_OFFSET_OPACITY] = v; this._onStaticDirty(); }

    get tintR(): number { return this.staticData[this.staticBase + STATIC_OFFSET_TINT_R]; }
    get tintG(): number { return this.staticData[this.staticBase + STATIC_OFFSET_TINT_G]; }
    get tintB(): number { return this.staticData[this.staticBase + STATIC_OFFSET_TINT_B]; }
    get tintA(): number { return this.staticData[this.staticBase + STATIC_OFFSET_TINT_A]; }

    setTint(r: number, g: number, b: number, a: number = 1): void {
        const s = this.staticData;
        const b2 = this.staticBase;
        s[b2 + STATIC_OFFSET_TINT_R] = r;
        s[b2 + STATIC_OFFSET_TINT_G] = g;
        s[b2 + STATIC_OFFSET_TINT_B] = b;
        s[b2 + STATIC_OFFSET_TINT_A] = a;
        this._onStaticDirty();
    }

    // --- UV access (read-only for user, set by renderer on sprite add) ---

    get uvMinX(): number { return this.staticData[this.staticBase + STATIC_OFFSET_UV_MIN_X]; }
    get uvMinY(): number { return this.staticData[this.staticBase + STATIC_OFFSET_UV_MIN_Y]; }
    get uvMaxX(): number { return this.staticData[this.staticBase + STATIC_OFFSET_UV_MAX_X]; }
    get uvMaxY(): number { return this.staticData[this.staticBase + STATIC_OFFSET_UV_MAX_Y]; }
}

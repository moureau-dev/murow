/**
 * Render state as plain data: blending, depth, culling, and write masks.
 *
 * A {@link RenderState} is built from optional options with sensible defaults.
 * Named blend modes expand to concrete blend components through a frozen
 * lookup table, and the blend mode stays available as a label.
 */

/** Named blend mode. */
export type BlendMode = 'opaque' | 'alpha' | 'additive' | 'premultiplied' | 'multiply' | 'screen';

/** Cull mode. */
export type CullMode = 'back' | 'front' | 'none';

/** Blend factor. */
export type BlendFactor =
    | 'zero'
    | 'one'
    | 'src'
    | 'one-minus-src'
    | 'src-alpha'
    | 'one-minus-src-alpha'
    | 'src-alpha-saturated'
    | 'dst'
    | 'one-minus-dst'
    | 'dst-alpha'
    | 'one-minus-dst-alpha'
    | 'constant'
    | 'one-minus-constant';

/** Blend operation. */
export type BlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';

/** One blend component. */
export interface BlendComponent {
    readonly srcFactor: BlendFactor;
    readonly dstFactor: BlendFactor;
    readonly operation: BlendOperation;
}

/** Color and alpha blend components. */
export interface BlendState {
    readonly color?: BlendComponent;
    readonly alpha?: BlendComponent;
}

/** Per-channel color write control. Omitted channels write. */
export interface ColorWriteMask {
    readonly r?: boolean;
    readonly g?: boolean;
    readonly b?: boolean;
    readonly a?: boolean;
}

/** Depth bias for coplanar decals and shadows. */
export interface DepthBias {
    readonly constant?: number;
    readonly slopeScale?: number;
    readonly clamp?: number;
}

/** Options for {@link RenderState}. */
export interface RenderStateOptions {
    /** Named blend mode. Default `'opaque'`. */
    readonly blend?: BlendMode;
    /** Explicit blend components. When set, takes precedence over `blend`. */
    readonly blendState?: BlendState | null;
    /** Default `true`. */
    readonly depthWrite?: boolean;
    /** Default `true`. */
    readonly depthTest?: boolean;
    /** Default `'none'`. */
    readonly cull?: CullMode;
    /** Channel write mask. `false` disables all channels; default writes all. */
    readonly colorWrite?: ColorWriteMask | boolean;
    readonly depthBias?: DepthBias;
}

const BLEND_ALPHA: BlendComponent = { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' };
const BLEND_ONE_MINUS_SRC_ALPHA: BlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
const BLEND_ONE: BlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

/** Blend components for each named mode. `null` means blending is disabled. */
export const BLEND_MODES: readonly (readonly [BlendMode, BlendState | null])[] = Object.freeze([
    ['opaque', null],
    ['alpha', { color: BLEND_ALPHA, alpha: BLEND_ONE_MINUS_SRC_ALPHA }],
    ['additive', { color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, alpha: BLEND_ONE }],
    ['premultiplied', { color: BLEND_ONE_MINUS_SRC_ALPHA, alpha: BLEND_ONE_MINUS_SRC_ALPHA }],
    ['multiply', { color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' }, alpha: BLEND_ONE_MINUS_SRC_ALPHA }],
    ['screen', { color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' }, alpha: BLEND_ONE_MINUS_SRC_ALPHA }],
] as const);

const CHANNEL_R = 1;
const CHANNEL_G = 2;
const CHANNEL_B = 4;
const CHANNEL_A = 8;
const ALL_CHANNELS = 15;

/** Blend components for a named mode, or null when blending is disabled. */
export function blendComponents(mode: BlendMode): BlendState | null {
    for (const [name, state] of BLEND_MODES) {
        if (name === mode) return state;
    }
    return null;
}

/** Resolve a color write mask to a bit mask. */
export function resolveColorWrite(mask: ColorWriteMask | boolean | undefined): number {
    if (mask === undefined || mask === true) return ALL_CHANNELS;
    if (mask === false) return 0;
    let flags = 0;
    if (mask.r !== false) flags |= CHANNEL_R;
    if (mask.g !== false) flags |= CHANNEL_G;
    if (mask.b !== false) flags |= CHANNEL_B;
    if (mask.a !== false) flags |= CHANNEL_A;
    return flags;
}

/**
 * Resolved render state. The constructor accepts the same options as
 * {@link RenderState.resolve} and fills every default.
 */
export class RenderState {
    readonly blend: BlendMode;
    /** Concrete blend components, or null when blending is disabled. */
    readonly blendState: BlendState | null;
    readonly depthWrite: boolean;
    readonly depthTest: boolean;
    readonly cull: CullMode;
    /** Color write mask as a bit field: r=1, g=2, b=4, a=8. */
    readonly colorWrite: number;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    readonly depthBiasClamp: number;

    constructor(options: RenderStateOptions = {}) {
        const blend = options.blend ?? 'opaque';
        const bias = options.depthBias ?? {};
        this.blend = blend;
        this.blendState = options.blendState !== undefined ? options.blendState : blendComponents(blend);
        this.depthWrite = options.depthWrite ?? true;
        this.depthTest = options.depthTest ?? true;
        this.cull = options.cull ?? 'none';
        this.colorWrite = resolveColorWrite(options.colorWrite);
        this.depthBias = bias.constant ?? 0;
        this.depthBiasSlopeScale = bias.slopeScale ?? 0;
        this.depthBiasClamp = bias.clamp ?? 0;
    }

    /** Build a resolved render state from options. */
    static resolve(options: RenderStateOptions = {}): RenderState {
        return new RenderState(options);
    }

    /** Whether the state draws with blending enabled. */
    get transparent(): boolean {
        return this.blendState !== null;
    }

    /** Whether any color channel is written. */
    get writesColor(): boolean {
        return this.colorWrite !== 0;
    }
}

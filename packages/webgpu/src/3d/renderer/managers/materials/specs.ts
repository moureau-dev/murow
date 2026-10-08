import type { AnyWgslData } from 'typegpu/data';

export type BlendMode =
    | 'opaque'
    | 'alpha'
    | 'additive'
    | 'premultiplied'
    | 'multiply'
    | 'screen';
export type CullMode = 'back' | 'front' | 'none';

export interface BlendState {
    readonly color?: GPUBlendComponent;
    readonly alpha?: GPUBlendComponent;
}

export interface ColorWriteMask {
    readonly r?: boolean;
    readonly g?: boolean;
    readonly b?: boolean;
    readonly a?: boolean;
}

export interface DepthBias {
    readonly constant?: number;
    readonly slopeScale?: number;
    readonly clamp?: number;
}

export interface MaterialRenderState {
    readonly blend?: BlendMode;
    /** Explicit blend components. When set, takes precedence over `blend`. */
    readonly blendState?: BlendState;
    readonly depthWrite?: boolean;
    readonly depthTest?: boolean;
    readonly cull?: CullMode;
    /** Channel write mask. `false` disables all channels; default writes all. */
    readonly colorWrite?: ColorWriteMask | boolean;
    /** Depth-bias for coplanar decals/shadows. */
    readonly depthBias?: DepthBias;
}

export interface MaterialSpecBase extends MaterialRenderState {
    /** Optional debug label. */
    readonly id?: string;
    /**
     * Shadow participation. `cast` adds the geometry to the shadow map;
     * `receive` samples it in the fragment. Both default to `true` for opaque
     * engine materials. Transparent materials never cast.
     */
    readonly shadow?: {
        readonly cast?: boolean;
        readonly receive?: boolean;
    };
}

export interface EngineMaterialSpec extends MaterialSpecBase {
    readonly type: 'standard' | 'unlit' | 'emissive';
    readonly color?: readonly [number, number, number];
    readonly opacity?: number;
    readonly emissive?: number;
    /** Discard fragments whose final alpha falls below this threshold. Default 0 (off). */
    readonly alphaTest?: number;
    /** UV tiling applied to the texture sample. Default `[1, 1]`. */
    readonly uvScale?: readonly [number, number];
    /** UV offset (in tiles) applied to the texture sample. Default `[0, 0]`. */
    readonly uvOffset?: readonly [number, number];
    /** Texture address mode. Default `'clamp'`. */
    readonly wrap?: 'repeat' | 'clamp';
    /** Texture filter. Default `'linear'`. */
    readonly filter?: 'linear' | 'nearest';
    /** Texture id from the asset bucket, resolved to a `gpuIndex` at compile. */
    readonly texture?: string;
}

export interface ShaderMaterialSpec extends MaterialSpecBase {
    readonly type: 'shader';
    readonly uniforms?: Record<string, AnyWgslData>;
    readonly defaultUniforms?: Record<string, number | readonly number[]>;
    readonly textures?: Readonly<Record<string, string>>;
    readonly lit?: boolean;
    readonly shaders: ShaderMaterialShaders;
}

export interface ShaderMaterialShaders {
    /** Optional custom vertex. When omitted, the engine mesh vertex is used. */
    readonly vertex?: {
        readonly out: Record<string, AnyWgslData>;
        readonly fn: (ctx: any, input: any) => Record<string, unknown>;
    };
    readonly fragment: { readonly fn: (input: any) => unknown };
}

export type MaterialSpec = EngineMaterialSpec | ShaderMaterialSpec;

export interface ResolvedRenderState {
    readonly blend: BlendMode;
    readonly blendState: BlendState | null;
    readonly depthWrite: boolean;
    readonly depthTest: boolean;
    readonly cull: CullMode;
    readonly colorWrite: number;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    readonly depthBiasClamp: number;
}

const COLORS = { r: 1, g: 2, b: 4, a: 8 };
const ALL_CHANNELS = 15;

function resolveColorWrite(mask: ColorWriteMask | boolean | undefined): number {
    if (mask === undefined || mask === true) return ALL_CHANNELS;
    if (mask === false) return 0;
    let flags = 0;
    if (mask.r !== false) flags |= COLORS.r;
    if (mask.g !== false) flags |= COLORS.g;
    if (mask.b !== false) flags |= COLORS.b;
    if (mask.a !== false) flags |= COLORS.a;
    return flags;
}

/** Blend components for a named mode, or null for opaque (blending disabled). */
export function blendComponents(mode: BlendMode): BlendState | null {
    switch (mode) {
        case 'opaque':
            return null;
        case 'alpha':
            return {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            };
        case 'additive':
            return {
                color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            };
        case 'premultiplied':
            return {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            };
        case 'multiply':
            return {
                color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            };
        case 'screen':
            return {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            };
    }
}

export function resolveRenderState(spec: MaterialSpec): ResolvedRenderState {
    const isEmissive = spec.type === 'emissive';
    const blend = spec.blend ?? (isEmissive ? 'additive' : 'opaque');
    const bias = spec.depthBias ?? {};
    return {
        blend,
        blendState: spec.blendState ?? blendComponents(blend),
        depthWrite: spec.depthWrite ?? !isEmissive,
        depthTest: spec.depthTest ?? true,
        cull: spec.cull ?? 'none',
        colorWrite: resolveColorWrite(spec.colorWrite),
        depthBias: bias.constant ?? 0,
        depthBiasSlopeScale: bias.slopeScale ?? 0,
        depthBiasClamp: bias.clamp ?? 0,
    };
}

export function isTransparent(state: ResolvedRenderState): boolean {
    return state.blend !== 'opaque' || state.blendState !== null;
}

import type { AnyWgslData } from 'typegpu/data';

export type BlendMode = 'opaque' | 'alpha' | 'additive';
export type CullMode = 'back' | 'front' | 'none';

export interface MaterialRenderState {
    readonly blend?: BlendMode;
    readonly depthWrite?: boolean;
    readonly depthTest?: boolean;
    readonly cull?: CullMode;
}

export interface MaterialSpecBase extends MaterialRenderState {
    /** Optional debug label. */
    readonly id?: string;
}

export interface EngineMaterialSpec extends MaterialSpecBase {
    readonly type: 'standard' | 'unlit' | 'emissive';
    readonly color?: readonly [number, number, number];
    readonly opacity?: number;
    readonly emissive?: number;
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
    readonly depthWrite: boolean;
    readonly depthTest: boolean;
    readonly cull: CullMode;
}

export function resolveRenderState(spec: MaterialSpec): ResolvedRenderState {
    const isEmissive = spec.type === 'emissive';
    return {
        blend: spec.blend ?? (isEmissive ? 'additive' : 'opaque'),
        depthWrite: spec.depthWrite ?? !isEmissive,
        depthTest: spec.depthTest ?? true,
        cull: spec.cull ?? 'none',
    };
}

export function isTransparent(state: ResolvedRenderState): boolean {
    return state.blend !== 'opaque';
}

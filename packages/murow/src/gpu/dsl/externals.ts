/**
 * Engine shader environment.
 *
 * Turns the built-in environment (struct schemas and standard bindings) into
 * IR-producing objects. Reading a uniform field builds an `access` node over
 * its `binding`; calling an environment function builds a `call` node whose
 * source the backend injects.
 *
 * Pure. No backend, no device.
 */
import type { GpuType } from '../types';
import type { IrExpr } from '../ir/nodes';
import { access, binding, call } from '../ir/builders';
import { array as arrayType, f32 as f32Type, sampler as samplerType, texture as textureType, vec as vecType } from '../ir/types';
import type { GpuStruct } from '../schema';
import { EngineMaterialUniforms, Light, MeshUniforms } from '../environment/structs';
import { StandardBindings, defaultBindings } from '../environment/bindings';
import { ShaderValue, toExpr, type ShaderInput } from './value';

/** A shader value that also resolves struct members by name. */
export type StructValue = ShaderValue & Record<string, any>;

/** Extra named uniforms read from the same binding as the base struct. */
export interface ExtraUniforms {
    readonly [name: string]: GpuType;
}

function structValue(base: IrExpr, definition: GpuStruct, extra?: ExtraUniforms): StructValue {
    const target = new ShaderValue({ node: base });
    return new Proxy(target, {
        get(internal, property, receiver) {
            if (typeof property === 'string') {
                const member = definition.member(property);
                if (member) {
                    return new ShaderValue({ node: access(member.field.type, base, property) });
                }
                const custom = extra?.[property];
                if (custom) {
                    return new ShaderValue({ node: access(custom, base, property) });
                }
            }
            return Reflect.get(internal, property, receiver);
        },
    }) as StructValue;
}

/** Options for the scene uniforms. */
export interface SceneOptions {
    readonly bindings?: StandardBindings;
}

/** Build the scene uniform view. */
export function createScene(options: SceneOptions = {}): StructValue {
    const bindings = options.bindings ?? defaultBindings;
    const base = binding(MeshUniforms.type, bindings.sceneGroup, bindings.sceneBinding);
    return structValue(base, MeshUniforms);
}

/** Options for the material uniforms, including custom named uniforms. */
export interface MaterialOptions {
    readonly bindings?: StandardBindings;
    readonly uniforms?: ExtraUniforms;
}

/** Build the material uniform view. */
export function createMaterial(options: MaterialOptions = {}): StructValue {
    const bindings = options.bindings ?? defaultBindings;
    const base = binding(EngineMaterialUniforms.type, bindings.materialGroup, bindings.materialBinding);
    return structValue(base, EngineMaterialUniforms, options.uniforms);
}

/** Indexable view over the light storage buffer. */
export interface LightsAccessor {
    at(index: ShaderInput): StructValue;
    readonly [index: number]: StructValue;
}

/** Options for the light buffer view. */
export interface LightsOptions {
    readonly bindings?: StandardBindings;
    readonly skinned?: boolean;
}

/** Build the light storage buffer view. */
export function createLights(options: LightsOptions = {}): LightsAccessor {
    const bindings = options.bindings ?? defaultBindings;
    const element = Light.type;
    const base = binding(arrayType(element, null), bindings.lightsGroup, bindings.lights(options.skinned ?? false));
    const at = (index: ShaderInput): StructValue => structValue(access(element, base, toExpr(index)), Light);
    const target = { at };
    return new Proxy(target, {
        get(internal, property, receiver) {
            if (typeof property === 'string' && !(property in target)) {
                const index = Number(property);
                if (Number.isInteger(index)) return at(index);
            }
            return Reflect.get(internal, property, receiver);
        },
    }) as unknown as LightsAccessor;
}

/** Options for the texture bindings. */
export interface TextureOptions {
    readonly bindings?: StandardBindings;
}

/** The material texture pair bindings, `map` and `mapSampler`, and further pairs. */
export class Textures {
    readonly map: ShaderValue;
    readonly mapSampler: ShaderValue;
    private readonly bindings: StandardBindings;

    constructor(options: TextureOptions = {}) {
        this.bindings = options.bindings ?? defaultBindings;
        const group = this.bindings.materialGroup;
        this.map = new ShaderValue({
            node: binding(textureType('f32', '2d', 'sample'), group, this.bindings.texture(0)),
        });
        this.mapSampler = new ShaderValue({
            node: binding(samplerType(false), group, this.bindings.texture(0) + 1),
        });
    }

    /** Texture binding of pair `index`. */
    texture(index: number): ShaderValue {
        return new ShaderValue({
            node: binding(textureType('f32', '2d', 'sample'), this.bindings.materialGroup, this.bindings.texture(index)),
        });
    }

    /** Sampler binding of pair `index`. */
    sampler(index: number): ShaderValue {
        return new ShaderValue({
            node: binding(samplerType(false), this.bindings.materialGroup, this.bindings.texture(index) + 1),
        });
    }
}

/** 3D value noise. */
export function noiseExternal(x: ShaderInput): ShaderValue {
    return new ShaderValue({ node: call(f32Type(), 'noise', [toExpr(x)]) });
}

/** Signed value noise. */
export function snoiseExternal(uv: ShaderInput, res: ShaderInput): ShaderValue {
    return new ShaderValue({ node: call(f32Type(), 'snoise', [toExpr(uv), toExpr(res)]) });
}

/** Reinhard tone map. */
export function tonemapExternal(c: ShaderInput): ShaderValue {
    return new ShaderValue({ node: call(vecType('f32', 3), 'tonemap', [toExpr(c)]) });
}

/** Options for the full environment. */
export interface ExternalsOptions {
    readonly bindings?: StandardBindings;
    readonly material?: MaterialOptions;
}

/** The full built-in environment. */
export interface Externals {
    readonly scene: StructValue;
    readonly material: StructValue;
    readonly lights: LightsAccessor;
    readonly textures: Textures;
    readonly noise: typeof noiseExternal;
    readonly snoise: typeof snoiseExternal;
    readonly tonemap: typeof tonemapExternal;
}

/** Build the environment, optionally with a custom binding map. */
export function createExternals(options: ExternalsOptions = {}): Externals {
    const bindings = options.bindings ?? defaultBindings;
    return {
        scene: createScene({ bindings }),
        material: createMaterial({ ...(options.material ?? {}), bindings }),
        lights: createLights({ bindings }),
        textures: new Textures({ bindings }),
        noise: noiseExternal,
        snoise: snoiseExternal,
        tonemap: tonemapExternal,
    };
}

/** The default environment. */
export const externals = createExternals();

export const scene = externals.scene;
export const material = externals.material;
export const lights = externals.lights;
export const textures = externals.textures;

import { sizeOf } from 'murow/gpu/dsl';
import type { RendererRuntime } from '../backend';
import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';

import { GpuBindGroupLayout, GpuShader, d, std } from 'murow/gpu';

import { tonemap } from '../shaders/utils';
import { std as engineStd } from '../gpu-ns';

type AnyField = import('murow/gpu/schema').Field<any, any> | import('murow/gpu/schema').GpuStruct;
type Infer<T> = any;
// The shader authoring DSL stays loose so bodies read naturally.

/** Pack a schema value to bytes for upload. */
function pack(schema: any, value: unknown): Uint8Array {
    const size = sizeOf(schema);
    const buffer = new ArrayBuffer(size);
    const dv = new DataView(buffer);
    if (Array.isArray(schema.fields)) for (const m of schema.fields) m.field.write(dv, m.offset, (value as Record<string, unknown>)?.[m.name]);
    else schema.write(dv, 0, value);
    return new Uint8Array(buffer);
}
import { SlotMap } from 'murow/core/slot-map';
import type { MaterialId } from '../ids';
import type { MeshPipelines } from '../internals/mesh-pipelines/mesh-pipelines';
import type { TextureRegistry } from '../internals/texture-registry';
import type { ShadowSystem } from '../shadows';
import { ShadowUniforms } from '../shadows';
import type { SpotShadowSystem } from '../shadows/spot-shadow-system';
import { SpotShadowUniforms } from '../shadows/spot-shadow-system';
import type { PointShadowSystem } from '../shadows/point-shadow-system';
import { PointShadowUniforms } from '../shadows/point-shadow-system';
import { createUnlitMeshVertex, createTexturedMeshVertex, createSkinnedMeshVertex, createExtrudedMeshVertex, createExtrudedSkinnedMeshVertex, type MeshDataLayout, type SkinnedMeshDataLayout } from '../shader';
import type { MaterialSpec, ResolvedRenderState } from './specs';
import type { IblManager } from '../ibl';
import { resolveRenderState, isTransparent } from './specs';
import {
    EngineMaterialUniforms,
    PbrMaterialUniforms,
    createEngineMaterialLayout,
    createPbrMaterialLayout,
    createStandardMaterialFragment,
    createPbrMaterialFragment,
    createUnlitMaterialFragment,
    createEmissiveMaterialFragment,
    createNoiseFn,
    createSnoiseFn,
    type EngineMaterialLayout,
    type PbrMaterialLayout,
} from './built-in';

type UniformSchema = Record<string, AnyField>;
type UniformValues<U extends UniformSchema> = { [K in keyof U]: Infer<U[K]> };

export interface MaterialHandle<
    U extends UniformSchema = UniformSchema,
    N extends string = string,
> {
    /** Stable, versioned identity, when created through `renderer.materials`. */
    readonly id: MaterialId;
    /** Unique name within the renderer's material library. */
    readonly name: N;
    /** False after destroy. */
    readonly alive: boolean;
    /** Material slot; the instance's `materialId` is `slot + 1` (0 = default). */
    readonly slot: number;
    readonly uniforms: UniformValues<U>;
    /** Update several uniform fields with one buffer upload. */
    setUniforms(values: Partial<UniformValues<U>>): void;
    setTexture(name: string, texture: string): void;
    /** Runtime toggle: whether this material's geometry casts a shadow. */
    setCastShadow(cast: boolean): void;
    /** Runtime toggle: whether this material samples the shadow map (engine materials). */
    setReceiveShadow(receive: boolean): void;
    /**
     * Idempotent. Throws when live instances still use the material; pass
     * `{ force: true }` to reassign them to the default material first.
     */
    destroy(opts?: { force?: boolean }): void;
}

export interface CompiledMaterial {
    readonly pipeline: RawRenderPipeline;
    /** Pipeline variant for skinned instances, when a skinned layout is available. */
    readonly skinnedPipeline: RawRenderPipeline | null;
    readonly bindGroup: RawBindGroup;
    readonly renderState: ResolvedRenderState;
    readonly transparent: boolean;
}

export interface MaterialLibraryDeps {
    runtime: RendererRuntime;
    root?: unknown;
    device: RawDevice;
    pipelines: MeshPipelines;
    textures: TextureRegistry;
    meshLayout: MeshDataLayout;
    /** Optional skinned layout; enables skinned pipeline variants. */
    skinnedLayout?: SkinnedMeshDataLayout;
        /** Directional shadow resources bound into every material. */
        shadow: ShadowSystem;
        /** Spot-light shadow resources bound into every material. */
        spotShadow: SpotShadowSystem;
        /** Point-light shadow resources bound into every material. */
        pointShadow: PointShadowSystem;
        /** Active image-based lighting environment. */
        ibl: IblManager;
    maxMaterials: number;
}

interface MaterialEntry {
    /** Registered name, when one was supplied (released on destroy). */
    name?: string;
    compiled: CompiledMaterial;
    buffer: RawBuffer;
    layout: any;
    mirror: Record<string, unknown>;
    textureNames: string[];
    textureIds: Record<string, string | null>;
    /** Per-texture sampler overrides (wrap/filter), re-applied on rebind. */
    samplerOverrides: Record<string, RawSampler> | undefined;
    /** Whether this material's geometry is added to the shadow map. */
    shadowCast: boolean;
    /** Whether this material binds the IBL resources. */
    usesIbl?: boolean;
    write(): void;
}

export class MaterialLibrary {
    private readonly runtime: RendererRuntime;
    private readonly slots: SlotMap;
    private readonly entries: (MaterialEntry | null)[];
    private readonly deps: MaterialLibraryDeps;
    private shaderVertex: ReturnType<typeof createTexturedMeshVertex> | null = null;
    private shaderSkinnedVertex: ReturnType<typeof createSkinnedMeshVertex> | null = null;
    private shaderUnlitVertex: ReturnType<typeof createUnlitMeshVertex> | null = null;
    private readonly samplers: { key: string; sampler: RawSampler }[] = [];
    /** Live instance users per 1-based material id; index 0 is the default. */
    private readonly useCounts: Uint32Array;
    /** Registered material names -> slot. Names are unique per renderer. */
    private readonly names = new Map<string, number>();

    /** The material id used by instances with no explicit material (the engine default). */
    readonly defaultMaterialId = 0;

    constructor(deps: MaterialLibraryDeps) {
        this.runtime = deps.runtime;
        this.deps = deps;
        this.slots = new SlotMap(deps.maxMaterials);
        this.entries = new Array(deps.maxMaterials).fill(null);
        this.useCounts = new Uint32Array(deps.maxMaterials + 1);
    }

    /** Whether a material name is currently registered. */
    hasName(name: string): boolean {
        return this.names.has(name);
    }

    /** Registered name of a 1-based material id, or undefined. */
    nameOf(materialId: number): string | undefined {
        if (materialId <= 0) return undefined;
        return this.entries[materialId - 1]?.name;
    }

    /** Live instance users of a 1-based material id (0 = default). */
    useCount(materialId: number): number {
        return materialId > 0 ? this.useCounts[materialId]! : 0;
    }

    /** Record one more instance using a 1-based material id. */
    retain(materialId: number): void {
        if (materialId > 0) this.useCounts[materialId]!++;
    }

    /** Record one fewer instance using a 1-based material id. */
    release(materialId: number): void {
        if (materialId > 0 && this.useCounts[materialId]! > 0) this.useCounts[materialId]!--;
    }

    get count(): number {
        return this.slots.size;
    }

    /** Compiled resources for a `materialId` (1-based), or null for the default. */
    get(materialId: number): CompiledMaterial | null {
        if (materialId <= 0) return null;
        return this.entries[materialId - 1]?.compiled ?? null;
    }

    /** Whether a material's geometry is added to the shadow map. */
    casts(materialId: number): boolean {
        if (materialId <= 0) return true;
        return this.entries[materialId - 1]?.shadowCast ?? true;
    }

    /** Recreate every material bind group (call after the shadow map is resized). */
    rebuildBindGroups(): void {
        for (let slot = 0; slot < this.entries.length; slot++) {
            const entry = this.entries[slot];
            if (!entry) continue;
            entry.compiled = {
                ...entry.compiled,
                bindGroup: this.createBindGroup(entry.layout, entry.buffer, entry.textureNames, entry.textureIds, entry.samplerOverrides, entry.usesIbl ? this.deps.ibl : undefined),
            };
        }
    }

    createMaterial<U extends UniformSchema = {}, N extends string = string>(spec: MaterialSpec, id?: MaterialId): MaterialHandle<U, N> {
        const slot = this.slots.add();
        if (slot === -1) throw new Error(`Max materials (${this.deps.maxMaterials}) reached`);

        const state = resolveRenderState(spec);
        const entry = spec.type === 'shader'
            ? this.createShaderMaterial(slot, spec, state)
            : spec.type === 'pbr'
                ? this.createPbrMaterial(slot, spec, state)
                : this.createEngineMaterial(slot, spec, state);

        if (spec.name !== undefined) {
            if (this.names.has(spec.name)) throw new Error(`Material "${spec.name}" is already registered`);
            this.names.set(spec.name, slot);
            entry.name = spec.name;
        }

        this.entries[slot] = entry;

        const mirror = entry.mirror;
        const uniforms = new Proxy(mirror, {
            get: (t, k) => (t as Record<string, unknown>)[k as string],
            set: (t, k, v) => {
                (t as Record<string, unknown>)[k as string] = v;
                entry.write();
                return true;
            },
        }) as unknown as UniformValues<U>;

        const self = this;
        let destroyed = false;
        const handle: MaterialHandle<U, N> = {
            id: (id ?? slot) as MaterialId,
            name: (spec.name ?? '') as N,
            get alive() { return !destroyed; },
            slot,
            uniforms,
            setUniforms(values) {
                self.setUniforms(slot, values);
            },
            setTexture(name, texture) {
                self.setTexture(slot, name, texture);
            },
            setCastShadow(cast) {
                self.setCast(slot, cast);
            },
            setReceiveShadow(receive) {
                self.setReceive(slot, receive);
            },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                self.destroy(slot);
            },
        };
        return handle;
    }

    private createEngineMaterial(slot: number, spec: Extract<MaterialSpec, { type: 'standard' | 'unlit' | 'emissive' }>, state: ResolvedRenderState): MaterialEntry {
        const layout = createEngineMaterialLayout();
        const buffer = this.runtime.createRawBuffer(EngineMaterialUniforms, 'uniform');
        const color = spec.color ?? [1, 1, 1];
        const uvScale = spec.uvScale ?? [1, 1];
        const uvOffset = spec.uvOffset ?? [0, 0];
        const mirror = {
            colorR: color[0], colorG: color[1], colorB: color[2],
            opacity: spec.opacity ?? 1,
            emissive: spec.emissive ?? 1,
            alphaTest: spec.alphaTest ?? 0,
            uvScaleU: uvScale[0], uvScaleV: uvScale[1],
            uvOffsetU: uvOffset[0], uvOffsetV: uvOffset[1],
            receiveShadow: (spec.shadow?.receive ?? true) ? 1 : 0,
            extrude: spec.extrude ?? 0,
        };
        this.deps.device.queue.writeBuffer(buffer, 0, pack(EngineMaterialUniforms, mirror) as RawBufferSource);

        // Built per material: the vertex reads this material's `extrude`, so it
        // must reference this material's bind-group layout object (not a cached one).
        const vertex = createExtrudedMeshVertex(this.deps.meshLayout, layout);
        const fragment = spec.type === 'unlit'
            ? createUnlitMaterialFragment(this.deps.meshLayout, layout)
            : spec.type === 'emissive'
                ? createEmissiveMaterialFragment(this.deps.meshLayout, layout)
                : createStandardMaterialFragment(this.deps.meshLayout, layout);

        const textureNames = ['map'];
        const textureIds: Record<string, string | null> = { map: spec.texture ?? null };
        const samplerOverrides = { map: this.getSampler(spec.wrap, spec.filter) };
        const pipeline = this.deps.pipelines.buildMaterialPipeline({
            vertex,
            fragment,
            materialLayout: layout,
            blendState: state.blendState, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            colorWrite: state.colorWrite, depthBias: state.depthBias,
            depthBiasSlopeScale: state.depthBiasSlopeScale, depthBiasClamp: state.depthBiasClamp,
            label: spec.id,
        });
        const skinnedPipeline = this.buildEngineSkinnedPipeline(spec, layout, state);
        const bindGroup = this.createBindGroup(layout, buffer, textureNames, textureIds, samplerOverrides);
        // Alpha-tested geometry would cast a solid rectangle (the shadow pass
        // ignores the alpha texture), so it does not cast unless asked.
        const shadowCast = (spec.shadow?.cast ?? (spec.alphaTest ?? 0) <= 0) && !isTransparent(state);
        return { compiled: { pipeline, skinnedPipeline, bindGroup, renderState: state, transparent: isTransparent(state) }, buffer, layout, mirror, textureNames, textureIds, samplerOverrides, shadowCast, write: () => this.deps.device.queue.writeBuffer(buffer, 0, pack(EngineMaterialUniforms, mirror) as RawBufferSource) };
    }

    private createPbrMaterial(slot: number, spec: Extract<MaterialSpec, { type: 'pbr' }>, state: ResolvedRenderState): MaterialEntry {
        const layout = createPbrMaterialLayout();
        const buffer = this.runtime.createRawBuffer(PbrMaterialUniforms, 'uniform');
        const color = spec.baseColor ?? [1, 1, 1];
        const emissive = spec.emissive ?? [0, 0, 0];
        const scale = spec.sampling?.scale ?? [1, 1];
        const offset = spec.sampling?.offset ?? [0, 0];
        const mirror = {
            colorR: color[0], colorG: color[1], colorB: color[2],
            opacity: spec.opacity ?? 1,
            alphaTest: spec.alphaTest ?? 0,
            uvScaleU: scale[0], uvScaleV: scale[1],
            uvOffsetU: offset[0], uvOffsetV: offset[1],
            receiveShadow: (spec.shadow?.receive ?? true) ? 1 : 0,
            metallic: spec.metallic ?? 0,
            roughness: spec.roughness ?? 0.5,
            occlusionStrength: spec.occlusionStrength ?? 1,
            emissiveR: emissive[0], emissiveG: emissive[1], emissiveB: emissive[2],
            hasMetallicRoughness: spec.textures?.metallicRoughness ? 1 : 0,
            normalScale: spec.normalScale ?? 1,
            hasNormalMap: spec.textures?.normal ? 1 : 0,
        };
        this.deps.device.queue.writeBuffer(buffer, 0, pack(PbrMaterialUniforms, mirror) as RawBufferSource);

        const vertex = createTexturedMeshVertex(this.deps.meshLayout);
        const fragment = createPbrMaterialFragment(this.deps.meshLayout, layout);

        const textureNames = ['baseColor', 'metallicRoughness', 'occlusion', 'emissive', 'normal'];
        const textureIds: Record<string, string | null> = {
            baseColor: spec.textures?.baseColor ?? null,
            metallicRoughness: spec.textures?.metallicRoughness ?? null,
            occlusion: spec.textures?.occlusion ?? null,
            emissive: spec.textures?.emissive ?? null,
            normal: spec.textures?.normal ?? null,
        };
        const sampler = this.getSampler(spec.sampling?.wrap, spec.sampling?.filter);
        const samplerOverrides = {
            baseColor: sampler,
            metallicRoughness: sampler,
            occlusion: sampler,
            emissive: sampler,
            normal: sampler,
        };
        const pipeline = this.deps.pipelines.buildMaterialPipeline({
            vertex,
            fragment,
            materialLayout: layout,
            blendState: state.blendState, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            colorWrite: state.colorWrite, depthBias: state.depthBias,
            depthBiasSlopeScale: state.depthBiasSlopeScale, depthBiasClamp: state.depthBiasClamp,
            label: spec.id,
        });
        const skinnedPipeline = this.buildPbrSkinnedPipeline(layout, state, spec.id);
        const bindGroup = this.createBindGroup(layout, buffer, textureNames, textureIds, samplerOverrides, this.deps.ibl);
        const shadowCast = (spec.shadow?.cast ?? (spec.alphaTest ?? 0) <= 0) && !isTransparent(state);
        return { compiled: { pipeline, skinnedPipeline, bindGroup, renderState: state, transparent: isTransparent(state) }, buffer, layout, mirror, textureNames, textureIds, samplerOverrides, shadowCast, usesIbl: true, write: () => this.deps.device.queue.writeBuffer(buffer, 0, pack(PbrMaterialUniforms, mirror) as RawBufferSource) };
    }

    private createShaderMaterial(slot: number, spec: Extract<MaterialSpec, { type: 'shader' }>, state: ResolvedRenderState): MaterialEntry {
        const schema: UniformSchema = spec.uniforms && Object.keys(spec.uniforms).length > 0
            ? spec.uniforms
            : { _unused: d.f32 };
        const Struct = d.struct(schema);
        const textureNames = spec.textures ? Object.keys(spec.textures) : ['map'];
        const bindings: Record<string, unknown> = { material: { uniform: Struct } };
        for (const name of textureNames) {
            bindings[name] = { texture: 'float' };
            bindings[`${name}Sampler`] = { sampler: 'filtering' };
        }
        bindings.shadow = { uniform: ShadowUniforms };
        bindings.shadowMap = { texture: 'float' };
        bindings.shadowSampler = { sampler: 'filtering' };
        bindings.spotShadow = { uniform: SpotShadowUniforms };
        bindings.spotShadowMap = { texture: 'float', viewDimension: '2d-array' };
        bindings.spotSampler = { sampler: 'filtering' };
        bindings.pointShadow = { uniform: PointShadowUniforms };
        bindings.pointShadowMap = { texture: 'float', viewDimension: 'cube-array' };
        bindings.pointSampler = { sampler: 'filtering' };
        const layout = new GpuBindGroupLayout(bindings as any);

        const { vertex, fragment } = this.compileDeclarative(spec, this.deps.meshLayout, layout, textureNames);

        const buffer = this.runtime.createRawBuffer(Struct, 'uniform');
        const keys = Object.keys(schema);
        const mirror: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            mirror[key] = spec.defaultUniforms?.[key] ?? zeroValue(schema[key]!);
        }
        const out: Record<string, unknown> = {};
        const writeMirror = () => {
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]!;
                out[key] = coerceUniform(schema[key]!, mirror[key]);
            }
            this.deps.device.queue.writeBuffer(buffer, 0, pack(Struct, out) as RawBufferSource);
        };
        writeMirror();

        const textureIds: Record<string, string | null> = {};
        for (const name of textureNames) textureIds[name] = spec.textures?.[name] ?? null;
        const pipeline = this.deps.pipelines.buildMaterialPipeline({
            vertex: vertex as any,
            fragment: fragment as any,
            materialLayout: layout,
            blendState: state.blendState, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            colorWrite: state.colorWrite, depthBias: state.depthBias,
            depthBiasSlopeScale: state.depthBiasSlopeScale, depthBiasClamp: state.depthBiasClamp,
            label: spec.id,
        });
        const skinnedPipeline = this.buildShaderSkinnedPipeline(spec, layout, state, textureNames);
        const bindGroup = this.createBindGroup(layout, buffer, textureNames, textureIds);
        const shadowCast = (spec.shadow?.cast ?? true) && !isTransparent(state);
        return { compiled: { pipeline, skinnedPipeline, bindGroup, renderState: state, transparent: isTransparent(state) }, buffer, layout, mirror, textureNames, textureIds, samplerOverrides: undefined, shadowCast, write: writeMirror };
    }

    private compileDeclarative(spec: Extract<MaterialSpec, { type: 'shader' }>, meshLayout: MeshDataLayout | SkinnedMeshDataLayout, matLayout: GpuBindGroupLayout, textureNames: string[], skinned = false) {
        const decl = spec.shaders;
        if (!decl.fragment || typeof decl.fragment.fn !== 'function') {
            throw new Error('createMaterial: shader materials require `shaders.fragment: { fn }`');
        }
        const noiseFn = createNoiseFn();
        const snoiseFn = createSnoiseFn();

        const textures: Record<string, string> = {};
        for (const name of textureNames) {
            textures[name] = `mat.${name}`;
            textures[`${name}Sampler`] = `mat.${name}Sampler`;
        }
        if (textureNames[0]) textures.sampler = `mat.${textureNames[0]}Sampler`;
        const expose: Record<string, string | Record<string, string>> = {
            material: 'mat.material',
            scene: 'mesh.uniforms',
            lights: 'mesh.lights',
            dynamic: 'mesh.dynamicInstances',
            statics: 'mesh.staticInstances',
            slotIndices: 'mesh.slotIndices',
            shadow: 'mat.shadow',
            shadowMap: 'mat.shadowMap',
            shadowSampler: 'mat.shadowSampler',
            textures,
        };
        const bindings = { mesh: meshLayout, mat: matLayout };
        const helpers = { std: engineStd, tonemap, noise: noiseFn, snoise: snoiseFn };

        let vertex: GpuShader;
        let fragmentIn: Record<string, unknown>;

        if (decl.vertex) {
            const vertexOut: Record<string, unknown> = { pos: d.builtin.position };
            fragmentIn = {};
            for (const [k, v] of Object.entries(decl.vertex.out)) {
                vertexOut[k] = v;
                fragmentIn[k] = v;
            }
            vertex = GpuShader.vertex({
                in: {
                    position: d.location(0, d.vec3f),
                    normal: d.location(1, d.vec3f),
                    uv: d.location(2, d.vec2f),
                    instanceIndex: d.builtin.instanceIndex,
                },
                out: vertexOut,
                bindings,
                expose,
                helpers,
            } as any, decl.vertex.fn as any);
        } else if (skinned) {
            if (!this.shaderSkinnedVertex) this.shaderSkinnedVertex = createSkinnedMeshVertex(meshLayout as SkinnedMeshDataLayout);
            vertex = this.shaderSkinnedVertex;
            fragmentIn = { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position, vCustom: d.vec2f };
        } else if (spec.lit === false) {
            if (!this.shaderUnlitVertex) this.shaderUnlitVertex = createUnlitMeshVertex(meshLayout as MeshDataLayout);
            vertex = this.shaderUnlitVertex;
            fragmentIn = { vColor: d.vec3f, vUV: d.vec2f, vCustom: d.vec2f };
        } else {
            if (!this.shaderVertex) this.shaderVertex = createTexturedMeshVertex(meshLayout as MeshDataLayout);
            vertex = this.shaderVertex;
            fragmentIn = { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position, vCustom: d.vec2f };
        }

        const fragment = GpuShader.fragment({
            in: fragmentIn,
            out: d.vec4f,
            bindings,
            expose,
            helpers,
        } as any, decl.fragment.fn as any);

        return { vertex, fragment };
    }

    private buildEngineSkinnedPipeline(spec: Extract<MaterialSpec, { type: 'standard' | 'unlit' | 'emissive' }>, layout: any, state: ResolvedRenderState): RawRenderPipeline | null {
        const skinnedLayout = this.deps.skinnedLayout;
        if (!skinnedLayout) return null;
        const vertex = createExtrudedSkinnedMeshVertex(skinnedLayout, layout);
        const fragment = spec.type === 'unlit'
            ? createUnlitMaterialFragment(skinnedLayout as any, layout)
            : spec.type === 'emissive'
                ? createEmissiveMaterialFragment(skinnedLayout as any, layout)
                : createStandardMaterialFragment(skinnedLayout as any, layout);
        return this.deps.pipelines.buildMaterialPipeline({
            vertex,
            fragment,
            materialLayout: layout,
            blendState: state.blendState, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            colorWrite: state.colorWrite, depthBias: state.depthBias,
            depthBiasSlopeScale: state.depthBiasSlopeScale, depthBiasClamp: state.depthBiasClamp,
            buffers: [this.deps.pipelines.skinnedVertexBufferLayout],
            meshBGL: this.deps.pipelines.rawSkinnedBGL,
            label: spec.id,
        });
    }

    private buildPbrSkinnedPipeline(layout: PbrMaterialLayout, state: ResolvedRenderState, label?: string): RawRenderPipeline | null {
        const skinnedLayout = this.deps.skinnedLayout;
        if (!skinnedLayout) return null;
        const vertex = createSkinnedMeshVertex(skinnedLayout);
        const fragment = createPbrMaterialFragment(skinnedLayout as unknown as MeshDataLayout, layout);
        return this.deps.pipelines.buildMaterialPipeline({
            vertex,
            fragment,
            materialLayout: layout,
            blendState: state.blendState, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            colorWrite: state.colorWrite, depthBias: state.depthBias,
            depthBiasSlopeScale: state.depthBiasSlopeScale, depthBiasClamp: state.depthBiasClamp,
            buffers: [this.deps.pipelines.skinnedVertexBufferLayout],
            meshBGL: this.deps.pipelines.rawSkinnedBGL,
            label,
        });
    }

    private buildShaderSkinnedPipeline(spec: Extract<MaterialSpec, { type: 'shader' }>, layout: any, state: ResolvedRenderState, textureNames: string[]): RawRenderPipeline | null {
        const skinnedLayout = this.deps.skinnedLayout;
        if (!skinnedLayout || spec.shaders.vertex) return null;
        const { vertex, fragment } = this.compileDeclarative(spec, skinnedLayout, layout, textureNames, true);
        return this.deps.pipelines.buildMaterialPipeline({
            vertex: vertex as any,
            fragment: fragment as any,
            materialLayout: layout,
            blendState: state.blendState, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            colorWrite: state.colorWrite, depthBias: state.depthBias,
            depthBiasSlopeScale: state.depthBiasSlopeScale, depthBiasClamp: state.depthBiasClamp,
            buffers: [this.deps.pipelines.skinnedVertexBufferLayout],
            meshBGL: this.deps.pipelines.rawSkinnedBGL,
            label: spec.id,
        });
    }

    private createBindGroup(
        layout: GpuBindGroupLayout,
        buffer: RawBuffer,
        textureNames: string[],
        textureIds: Record<string, string | null>,
        samplerOverrides?: Record<string, RawSampler>,
        ibl?: IblManager,
    ): RawBindGroup {
        const entries: RawBindGroupEntry[] = [
            { binding: 0, resource: { buffer } },
        ];
        let binding = 1;
        for (const name of textureNames) {
            const { view, sampler } = this.resolveTexture(textureIds[name] ?? null);
            entries.push({ binding: binding++, resource: view });
            entries.push({ binding: binding++, resource: samplerOverrides?.[name] ?? sampler });
        }
        entries.push({ binding: binding++, resource: { buffer: this.deps.shadow.uniforms } });
        entries.push({ binding: binding++, resource: this.deps.shadow.mapTexture });
        entries.push({ binding: binding++, resource: this.deps.shadow.mapSampler });
        entries.push({ binding: binding++, resource: { buffer: this.deps.spotShadow.uniforms } });
        entries.push({ binding: binding++, resource: this.deps.spotShadow.mapTexture });
        entries.push({ binding: binding++, resource: this.deps.spotShadow.mapSampler });
        entries.push({ binding: binding++, resource: { buffer: this.deps.pointShadow.uniforms } });
        entries.push({ binding: binding++, resource: this.deps.pointShadow.mapTexture });
        entries.push({ binding: binding++, resource: this.deps.pointShadow.mapSampler });
        if (ibl) {
            entries.push({ binding: binding++, resource: { buffer: ibl.uniformBuffer } });
            entries.push({ binding: binding++, resource: ibl.envView });
            entries.push({ binding: binding++, resource: ibl.sampler });
            entries.push({ binding: binding++, resource: ibl.irradianceView });
            entries.push({ binding: binding++, resource: ibl.sampler });
        }
        return this.deps.device.createBindGroup({
            layout: this.runtime.createBindGroupLayout(layout.toDescriptor()),
            entries,
        });
    }

    /** Sampler for a texture address mode + filter combination, cached by config. */
    private getSampler(wrap?: 'repeat' | 'clamp', filter?: 'linear' | 'nearest'): RawSampler {
        const mode = wrap === 'repeat' ? 'repeat' : 'clamp-to-edge';
        const filtering = filter === 'nearest' ? 'nearest' : 'linear';
        const key = `${mode}|${filtering}`;
        // Wrap x filter is a fixed set (<= 4), so a small linear scan beats a Map.
        for (let i = 0; i < this.samplers.length; i++) {
            if (this.samplers[i]!.key === key) return this.samplers[i]!.sampler;
        }
        const sampler = this.deps.device.createSampler({
            addressModeU: mode,
            addressModeV: mode,
            magFilter: filtering,
            minFilter: filtering,
            mipmapFilter: 'linear',
        });
        this.samplers.push({ key, sampler });
        return sampler;
    }

    private resolveTexture(textureId: string | null): { view: RawTextureView; sampler: RawSampler } {
        if (textureId) {
            const tex = this.deps.textures.get(textureId);
            if (tex) return { view: tex.view, sampler: tex.sampler };
        }
        const white = this.deps.textures.whiteTexture;
        return { view: white.view, sampler: white.sampler };
    }

    /** Runtime toggle for a material's shadow casting. */
    private setCast(slot: number, cast: boolean): void {
        const entry = this.entries[slot];
        if (entry) entry.shadowCast = cast;
    }

    /** Runtime toggle for a material's shadow receiving (engine materials only). */
    private setReceive(slot: number, receive: boolean): void {
        const entry = this.entries[slot];
        if (!entry || !('receiveShadow' in entry.mirror)) return;
        entry.mirror.receiveShadow = receive ? 1 : 0;
        entry.write();
    }

    private setUniforms(slot: number, values: Record<string, unknown>): void {
        const entry = this.entries[slot];
        if (!entry) return;
        for (const key of Object.keys(values)) {
            entry.mirror[key] = values[key];
        }
        entry.write();
    }

    private setTexture(slot: number, name: string, textureId: string): void {
        const entry = this.entries[slot];
        if (!entry || !(name in entry.textureIds)) return;
        entry.textureIds[name] = textureId;
        if (name === 'metallicRoughness' && 'hasMetallicRoughness' in entry.mirror) {
            entry.mirror.hasMetallicRoughness = textureId ? 1 : 0;
            entry.write();
        }
        if (name === 'normal' && 'hasNormalMap' in entry.mirror) {
            entry.mirror.hasNormalMap = textureId ? 1 : 0;
            entry.write();
        }
        entry.compiled = {
            ...entry.compiled,
            bindGroup: this.createBindGroup(entry.layout, entry.buffer, entry.textureNames, entry.textureIds, entry.samplerOverrides, entry.usesIbl ? this.deps.ibl : undefined),
        };
    }

    private destroy(slot: number): void {
        const entry = this.entries[slot];
        if (!entry) return;
        if (entry.name !== undefined) this.names.delete(entry.name);
        entry.buffer.destroy();
        this.entries[slot] = null;
        this.slots.remove(slot);
    }
}

function coerceUniform(_type: AnyField, value: unknown): unknown {
    return value;
}

function zeroValue(type: AnyField): unknown {
    if (type === (d.vec2f as unknown)) return [0, 0];
    if (type === (d.vec3f as unknown)) return [0, 0, 0];
    if (type === (d.vec4f as unknown)) return [0, 0, 0, 0];
    return 0;
}

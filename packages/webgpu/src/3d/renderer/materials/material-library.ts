import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import type { Infer, AnyWgslData } from 'typegpu/data';
import { tgpu, d, std } from '../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import { lightContribution, tonemap } from '../../../shaders/utils';
import { SlotMap } from 'murow/core/slot-map';
import type { MeshPipelines } from '../pipelines/mesh-pipelines';
import type { TextureRegistry } from '../textures';
import type { ShadowSystem } from '../shadows';
import { ShadowUniforms } from '../shadows';
import { createUnlitMeshVertex, createSkinnedMeshVertex, type MeshDataLayout, type SkinnedMeshDataLayout } from '../../shader';
import type { MaterialSpec, ResolvedRenderState } from './specs';
import { resolveRenderState, isTransparent } from './specs';
import {
    EngineMaterialUniforms,
    createEngineMaterialLayout,
    createStandardMaterialFragment,
    createUnlitMaterialFragment,
    createEmissiveMaterialFragment,
    createTexturedMeshVertex,
    createNoiseFn,
    createSnoiseFn,
    type EngineMaterialLayout,
} from './built-in';

type UniformSchema = Record<string, AnyWgslData>;
type UniformValues<U extends UniformSchema> = { [K in keyof U]: Infer<U[K]> };

export interface MaterialHandle<U extends UniformSchema = UniformSchema> {
    /** Material slot; the instance's `materialId` is `slot + 1` (0 = default). */
    readonly slot: number;
    readonly uniforms: UniformValues<U>;
    setTexture(name: string, texture: string): void;
    /** Runtime toggle: whether this material's geometry casts a shadow. */
    setCastShadow(cast: boolean): void;
    /** Runtime toggle: whether this material samples the shadow map (engine materials). */
    setReceiveShadow(receive: boolean): void;
    destroy(): void;
}

export interface CompiledMaterial {
    readonly pipeline: GPURenderPipeline;
    /** Pipeline variant for skinned instances, when a skinned layout is available. */
    readonly skinnedPipeline: GPURenderPipeline | null;
    readonly bindGroup: GPUBindGroup;
    readonly renderState: ResolvedRenderState;
    readonly transparent: boolean;
}

export interface MaterialLibraryDeps {
    root: TgpuRoot;
    device: GPUDevice;
    pipelines: MeshPipelines;
    textures: TextureRegistry;
    meshLayout: MeshDataLayout;
    /** Optional skinned layout; enables skinned pipeline variants. */
    skinnedLayout?: SkinnedMeshDataLayout;
    /** Directional shadow resources bound into every material. */
    shadow: ShadowSystem;
    maxMaterials: number;
}

interface MaterialEntry {
    compiled: CompiledMaterial;
    buffer: TgpuBuffer<any>;
    layout: any;
    mirror: Record<string, unknown>;
    textureNames: string[];
    textureIds: Record<string, string | null>;
    /** Per-texture sampler overrides (wrap/filter), re-applied on rebind. */
    samplerOverrides: Record<string, GPUSampler> | undefined;
    /** Whether this material's geometry is added to the shadow map. */
    shadowCast: boolean;
    write(): void;
}

export class MaterialLibrary {
    private readonly slots: SlotMap;
    private readonly entries: (MaterialEntry | null)[];
    private readonly deps: MaterialLibraryDeps;
    private engineVertex: ReturnType<typeof createTexturedMeshVertex> | null = null;
    private engineSkinnedVertex: ReturnType<typeof createSkinnedMeshVertex> | null = null;
    private engineUnlitVertex: ReturnType<typeof createUnlitMeshVertex> | null = null;
    private readonly samplers: { key: string; sampler: GPUSampler }[] = [];

    constructor(deps: MaterialLibraryDeps) {
        this.deps = deps;
        this.slots = new SlotMap(deps.maxMaterials);
        this.entries = new Array(deps.maxMaterials).fill(null);
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
                bindGroup: this.createBindGroup(entry.layout, entry.buffer, entry.textureNames, entry.textureIds, entry.samplerOverrides),
            };
        }
    }

    createMaterial<U extends UniformSchema = {}>(spec: MaterialSpec): MaterialHandle<U> {
        const slot = this.slots.add();
        if (slot === -1) throw new Error(`Max materials (${this.deps.maxMaterials}) reached`);

        const state = resolveRenderState(spec);
        const entry = spec.type === 'shader'
            ? this.createShaderMaterial(slot, spec, state)
            : this.createEngineMaterial(slot, spec, state);

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
        const handle: MaterialHandle<U> = {
            slot,
            uniforms,
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
                self.destroy(slot);
            },
        };
        return handle;
    }

    private createEngineMaterial(slot: number, spec: Extract<MaterialSpec, { type: 'standard' | 'unlit' | 'emissive' }>, state: ResolvedRenderState): MaterialEntry {
        const layout = createEngineMaterialLayout();
        const buffer = this.deps.root.createBuffer(EngineMaterialUniforms).$usage('uniform');
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
            receiveShadow: (spec.shadow?.receive ?? true) ? 1 : 0, _pad1: 0,
        };
        buffer.write(mirror);

        if (!this.engineVertex) this.engineVertex = createTexturedMeshVertex(this.deps.meshLayout);
        const fragment = spec.type === 'unlit'
            ? createUnlitMaterialFragment(this.deps.meshLayout, layout)
            : spec.type === 'emissive'
                ? createEmissiveMaterialFragment(this.deps.meshLayout, layout)
                : createStandardMaterialFragment(this.deps.meshLayout, layout);

        const textureNames = ['map'];
        const textureIds: Record<string, string | null> = { map: spec.texture ?? null };
        const samplerOverrides = { map: this.getSampler(spec.wrap, spec.filter) };
        const pipeline = this.deps.pipelines.buildMaterialPipeline({
            vertex: this.engineVertex,
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
        return { compiled: { pipeline, skinnedPipeline, bindGroup, renderState: state, transparent: isTransparent(state) }, buffer, layout, mirror, textureNames, textureIds, samplerOverrides, shadowCast, write: () => buffer.write(mirror as never) };
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
        const layout = tgpu.bindGroupLayout(bindings as any);

        const { vertex, fragment } = this.compileDeclarative(spec, this.deps.meshLayout, layout, textureNames);

        const buffer = this.deps.root.createBuffer(Struct).$usage('uniform');
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
            buffer.write(out as never);
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

    private compileDeclarative(spec: Extract<MaterialSpec, { type: 'shader' }>, meshLayout: MeshDataLayout | SkinnedMeshDataLayout, matLayout: any, textureNames: string[], skinned = false) {
        const decl = spec.shaders;
        if (!decl.fragment || typeof decl.fragment.fn !== 'function') {
            throw new Error('createMaterial: shader materials require `shaders.fragment: { fn }`');
        }
        const noiseFn = createNoiseFn(matLayout);
        const snoiseFn = createSnoiseFn(matLayout);

        const resolveExternals = () => () => {
            const ext: Record<string, unknown> = { d, std, meshLayout, matLayout, lightContribution, tonemap, noise: noiseFn, snoise: snoiseFn };
            try { ext.scene = (meshLayout as any).$.uniforms; } catch { /* outside shader */ }
            try {
                ext.lights = (meshLayout as any).$.lights;
                ext.dynamic = (meshLayout as any).$.dynamicInstances;
                ext.statics = (meshLayout as any).$.staticInstances;
                ext.slotIndices = (meshLayout as any).$.slotIndices;
            } catch { /* outside shader */ }
            try {
                ext.material = (matLayout as any).$.material;
                const textures: Record<string, unknown> = {};
                for (const name of textureNames) {
                    textures[name] = (matLayout as any).$[name];
                    textures[`${name}Sampler`] = (matLayout as any).$[`${name}Sampler`];
                }
                if (textureNames[0]) textures.sampler = (matLayout as any).$[`${textureNames[0]}Sampler`];
                ext.textures = textures;
                ext.shadow = (matLayout as any).$.shadow;
                ext.shadowMap = (matLayout as any).$.shadowMap;
                ext.shadowSampler = (matLayout as any).$.shadowSampler;
            } catch { /* outside shader */ }
            return ext;
        };

        let vertex: any;
        let fragmentIn: Record<string, unknown>;

        if (decl.vertex) {
            const vertexOut: Record<string, unknown> = { pos: d.builtin.position };
            fragmentIn = {};
            for (const [k, v] of Object.entries(decl.vertex.out)) {
                vertexOut[k] = v;
                fragmentIn[k] = v;
            }
            attachShaderMetadata(decl.vertex.fn as any, resolveExternals(), true, { d, std, meshLayout, matLayout } as any);
            vertex = tgpu.vertexFn({
                in: {
                    position: d.location(0, d.vec3f),
                    normal: d.location(1, d.vec3f),
                    uv: d.location(2, d.vec2f),
                    instanceIndex: d.builtin.instanceIndex,
                },
                out: vertexOut,
            } as any)(decl.vertex.fn as any);
        } else if (skinned) {
            if (!this.engineSkinnedVertex) this.engineSkinnedVertex = createSkinnedMeshVertex(meshLayout as SkinnedMeshDataLayout);
            vertex = this.engineSkinnedVertex;
            fragmentIn = { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position, vCustom: d.vec2f };
        } else if (spec.lit === false) {
            if (!this.engineUnlitVertex) this.engineUnlitVertex = createUnlitMeshVertex(meshLayout as MeshDataLayout);
            vertex = this.engineUnlitVertex;
            fragmentIn = { vColor: d.vec3f, vUV: d.vec2f, vCustom: d.vec2f };
        } else {
            if (!this.engineVertex) this.engineVertex = createTexturedMeshVertex(meshLayout as MeshDataLayout);
            vertex = this.engineVertex;
            fragmentIn = { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f, frontFacing: d.builtin.frontFacing, position: d.builtin.position, vCustom: d.vec2f };
        }

        // The skinned variant attaches independent metadata to a placeholder fn
        // (via `sourceOverride`), so it does not clobber the main fragment's
        // metadata on the shared user function.
        const userFragmentFn = decl.fragment.fn as Function;
        const fragmentTarget: Function = skinned ? function() {} : userFragmentFn;
        attachShaderMetadata(
            fragmentTarget as any,
            resolveExternals(),
            false,
            { d, std, meshLayout, matLayout } as any,
            undefined,
            skinned ? userFragmentFn.toString() : undefined,
        );
        const fragment = tgpu.fragmentFn({ in: fragmentIn, out: d.vec4f } as any)(fragmentTarget as any);

        return { vertex, fragment };
    }

    private buildEngineSkinnedPipeline(spec: Extract<MaterialSpec, { type: 'standard' | 'unlit' | 'emissive' }>, layout: any, state: ResolvedRenderState): GPURenderPipeline | null {
        const skinnedLayout = this.deps.skinnedLayout;
        if (!skinnedLayout) return null;
        if (!this.engineSkinnedVertex) this.engineSkinnedVertex = createSkinnedMeshVertex(skinnedLayout);
        const fragment = spec.type === 'unlit'
            ? createUnlitMaterialFragment(skinnedLayout as any, layout)
            : spec.type === 'emissive'
                ? createEmissiveMaterialFragment(skinnedLayout as any, layout)
                : createStandardMaterialFragment(skinnedLayout as any, layout);
        return this.deps.pipelines.buildMaterialPipeline({
            vertex: this.engineSkinnedVertex,
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

    private buildShaderSkinnedPipeline(spec: Extract<MaterialSpec, { type: 'shader' }>, layout: any, state: ResolvedRenderState, textureNames: string[]): GPURenderPipeline | null {
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
        layout: any,
        buffer: TgpuBuffer<any>,
        textureNames: string[],
        textureIds: Record<string, string | null>,
        samplerOverrides?: Record<string, GPUSampler>,
    ): GPUBindGroup {
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: this.deps.root.unwrap(buffer) as unknown as GPUBuffer } },
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
        return this.deps.device.createBindGroup({
            layout: this.deps.root.unwrap(layout) as unknown as GPUBindGroupLayout,
            entries,
        });
    }

    /** Sampler for a texture address mode + filter combination, cached by config. */
    private getSampler(wrap?: 'repeat' | 'clamp', filter?: 'linear' | 'nearest'): GPUSampler {
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

    private resolveTexture(textureId: string | null): { view: GPUTextureView; sampler: GPUSampler } {
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

    private setTexture(slot: number, name: string, textureId: string): void {
        const entry = this.entries[slot];
        if (!entry || !(name in entry.textureIds)) return;
        entry.textureIds[name] = textureId;
        entry.compiled = {
            ...entry.compiled,
            bindGroup: this.createBindGroup(entry.layout, entry.buffer, entry.textureNames, entry.textureIds, entry.samplerOverrides),
        };
    }

    private destroy(slot: number): void {
        const entry = this.entries[slot];
        if (!entry) return;
        entry.buffer.destroy();
        this.entries[slot] = null;
        this.slots.remove(slot);
    }
}

function coerceUniform(type: AnyWgslData, value: unknown): unknown {
    if (Array.isArray(value)) {
        const a = value as number[];
        if (type === (d.vec2f as unknown)) return d.vec2f(a[0]!, a[1]!);
        if (type === (d.vec3f as unknown)) return d.vec3f(a[0]!, a[1]!, a[2]!);
        if (type === (d.vec4f as unknown)) return d.vec4f(a[0]!, a[1]!, a[2]!, a[3]!);
    }
    return value;
}

function zeroValue(type: AnyWgslData): unknown {
    if (type === (d.vec2f as unknown)) return [0, 0];
    if (type === (d.vec3f as unknown)) return [0, 0, 0];
    if (type === (d.vec4f as unknown)) return [0, 0, 0, 0];
    return 0;
}

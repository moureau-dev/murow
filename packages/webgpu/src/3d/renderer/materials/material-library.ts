import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import type { Infer, AnyWgslData } from 'typegpu/data';
import { tgpu, d, std } from '../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import { lightContribution, tonemap } from '../../../shaders/utils';
import { SlotMap } from 'murow/core/slot-map';
import type { MeshPipelines } from '../pipelines/mesh-pipelines';
import type { TextureRegistry } from '../textures';
import { createUnlitMeshVertex, type MeshDataLayout } from '../../shader';
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
    destroy(): void;
}

export interface CompiledMaterial {
    readonly pipeline: GPURenderPipeline;
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
    maxMaterials: number;
}

interface MaterialEntry {
    compiled: CompiledMaterial;
    buffer: TgpuBuffer<any>;
    layout: any;
    mirror: Record<string, unknown>;
    textureNames: string[];
    textureIds: Record<string, string | null>;
    write(): void;
}

export class MaterialLibrary {
    private readonly slots: SlotMap;
    private readonly entries: (MaterialEntry | null)[];
    private readonly deps: MaterialLibraryDeps;
    private engineVertex: ReturnType<typeof createTexturedMeshVertex> | null = null;
    private engineUnlitVertex: ReturnType<typeof createUnlitMeshVertex> | null = null;

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
        const mirror = {
            colorR: color[0], colorG: color[1], colorB: color[2],
            opacity: spec.opacity ?? 1,
            emissive: spec.emissive ?? 1,
            _pad0: 0, _pad1: 0, _pad2: 0,
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
        const pipeline = this.deps.pipelines.buildMaterialPipeline({
            vertex: this.engineVertex,
            fragment,
            materialLayout: layout,
            blend: state.blend, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            label: spec.id,
        });
        const bindGroup = this.createBindGroup(layout, buffer, textureNames, textureIds);
        return { compiled: { pipeline, bindGroup, renderState: state, transparent: isTransparent(state) }, buffer, layout, mirror, textureNames, textureIds, write: () => buffer.write(mirror as never) };
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
        const layout = tgpu.bindGroupLayout(bindings as any);

        const { vertex, fragment } = this.compileDeclarative(spec, this.deps.meshLayout, layout, textureNames);

        const buffer = this.deps.root.createBuffer(Struct).$usage('uniform');
        const mirror: Record<string, unknown> = {};
        for (const key of Object.keys(schema)) {
            const fromDefaults = spec.defaultUniforms?.[key];
            mirror[key] = fromDefaults ?? zeroValue(schema[key]!);
        }
        const writeMirror = () => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(schema)) out[key] = coerceUniform(schema[key]!, mirror[key]);
            buffer.write(out as never);
        };
        writeMirror();

        const textureIds: Record<string, string | null> = {};
        for (const name of textureNames) textureIds[name] = spec.textures?.[name] ?? null;
        const pipeline = this.deps.pipelines.buildMaterialPipeline({
            vertex: vertex as any,
            fragment: fragment as any,
            materialLayout: layout,
            blend: state.blend, depthWrite: state.depthWrite, depthTest: state.depthTest, cull: state.cull,
            label: spec.id,
        });
        const bindGroup = this.createBindGroup(layout, buffer, textureNames, textureIds);
        return { compiled: { pipeline, bindGroup, renderState: state, transparent: isTransparent(state) }, buffer, layout, mirror, textureNames, textureIds, write: writeMirror };
    }

    private compileDeclarative(spec: Extract<MaterialSpec, { type: 'shader' }>, meshLayout: MeshDataLayout, matLayout: any, textureNames: string[]) {
        const decl = spec.shaders;
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
        } else if (spec.lit === false) {
            if (!this.engineUnlitVertex) this.engineUnlitVertex = createUnlitMeshVertex(meshLayout);
            vertex = this.engineUnlitVertex;
            fragmentIn = { vColor: d.vec3f, vUV: d.vec2f };
        } else {
            if (!this.engineVertex) this.engineVertex = createTexturedMeshVertex(meshLayout);
            vertex = this.engineVertex;
            fragmentIn = { vNormal: d.vec3f, vColor: d.vec3f, vUV: d.vec2f, vWorldPos: d.vec3f };
        }

        attachShaderMetadata(decl.fragment.fn as any, resolveExternals(), false, { d, std, meshLayout, matLayout } as any);
        const fragment = tgpu.fragmentFn({ in: fragmentIn, out: d.vec4f } as any)(decl.fragment.fn as any);

        return { vertex, fragment };
    }

    private createBindGroup(layout: any, buffer: TgpuBuffer<any>, textureNames: string[], textureIds: Record<string, string | null>): GPUBindGroup {
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: this.deps.root.unwrap(buffer) as unknown as GPUBuffer } },
        ];
        let binding = 1;
        for (const name of textureNames) {
            const { view, sampler } = this.resolveTexture(textureIds[name] ?? null);
            entries.push({ binding: binding++, resource: view });
            entries.push({ binding: binding++, resource: sampler });
        }
        return this.deps.device.createBindGroup({
            layout: this.deps.root.unwrap(layout) as unknown as GPUBindGroupLayout,
            entries,
        });
    }

    private resolveTexture(textureId: string | null): { view: GPUTextureView; sampler: GPUSampler } {
        if (textureId) {
            const tex = this.deps.textures.get(textureId);
            if (tex) return { view: tex.view, sampler: tex.sampler };
        }
        const white = this.deps.textures.whiteTexture;
        return { view: white.view, sampler: white.sampler };
    }

    private setTexture(slot: number, name: string, textureId: string): void {
        const entry = this.entries[slot];
        if (!entry || !(name in entry.textureIds)) return;
        entry.textureIds[name] = textureId;
        entry.compiled = {
            ...entry.compiled,
            bindGroup: this.createBindGroup(entry.layout, entry.buffer, entry.textureNames, entry.textureIds),
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

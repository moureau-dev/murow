import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';

import { SlotMap, SlotSet } from 'murow/core/slot-map';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { TexturePrefab } from 'murow/renderer';
import { resolveRenderLayer, type LayerRegistry } from '../../../layers';
import { DYNAMIC_MESH_FLOATS, STATIC_MESH_FLOATS } from '../engine-core/types';
import type { MeshInstanceHandle, MeshInstanceOptions, ModelHandle } from '../types';
import {
    DYN_PREV_PX, DYN_PREV_PY, DYN_PREV_PZ,
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    DYN_PREV_RX, DYN_PREV_RY, DYN_PREV_RZ,
    DYN_CURR_RX, DYN_CURR_RY, DYN_CURR_RZ, DYN_MORPH,
    STAT_SX, STAT_SY, STAT_SZ, STAT_CR, STAT_CG, STAT_CB,
    STAT_MATERIAL_ID, STAT_CUSTOM0, STAT_CUSTOM1,
    MAX_MATERIALS_PER_INSTANCE,
} from './offsets';
import { InstanceLodStore } from './lod-store';
import { resolveTransform } from './transform';
import { EMPTY_MATERIALS } from './empty-materials';

export interface InstanceStoreDeps {
    maxInstances: number;
    /** Resolves layer names and the default bit. */
    layers: LayerRegistry;
    /** Bind group for a registered texture id, or undefined. */
    getTextureBindGroup(id: string): RawBindGroup | undefined;
    /** Record one instance starting to use a 1-based material id (0 = default). */
    retainMaterial?(materialId: number): void;
    /** Record one instance stopping use of a 1-based material id. */
    releaseMaterial?(materialId: number): void;
}

/**
 * InstanceStore — owns the non-skinned instance pool: dense dynamic/static
 * Float32Arrays, the FreeList of slots, the SparseBatcher grouping, per-instance
 * handles and texture overrides. Renderer supplies GPU/asset lookups via deps.
 */
export class InstanceStore {
    readonly dynamicData: Float32Array;
    readonly staticData: Float32Array;
    readonly slotIndexData: Uint32Array;
    /** Per-slot render layer bit. */
    readonly layerData: Uint32Array;
    /** Bumped on any transform/structure change; lets consumers cache GPU passes. */
    dynamicVersion = 0;
    readonly instanceModelIds: Uint8Array;
    readonly instanceHandles: (MeshInstanceHandle | null)[];
    readonly batcher: SparseBatcher;

    staticDirty = false;

    /** Dense live-slot set; iterate `activeSlots` over `[0, size)`. */
    readonly slots: SlotMap;
    /** Per-slot material ids, `MAX_MATERIALS_PER_INSTANCE` per slot (0 = default). */
    readonly materialIds: Uint16Array;
    /** Number of materials in each slot's list (always at least 1). */
    readonly materialCount: Uint8Array;
    /** Per-slot texture override bind group, or null for the model default. */
    private readonly textureBGs: (RawBindGroup | null)[];
    /** Per-slot occlusion flags: bit 0 cullable, bit 1 occluder. */
    private readonly instanceFlags: Uint8Array;

    /**
     * Optional GPU buffer holding the packed candidate slot list occlusion
     * culling reads. The renderer sets this; null means no candidates.
     */
    slotIndexBuffer: RawBuffer | null = null;

    /** Level-of-detail state and selection. */
    readonly lod: InstanceLodStore;
    /** Per-slot LOD fade companion slot (a ghost at the target level), or -1. */
    private readonly companions: Int32Array;
    /** Dense set of main slots that currently have an active companion. */
    private readonly companionSlots: SlotSet;

    constructor(private readonly deps: InstanceStoreDeps) {
        const n = deps.maxInstances;
        this.dynamicData = new Float32Array(n * DYNAMIC_MESH_FLOATS);
        this.staticData = new Float32Array(n * STATIC_MESH_FLOATS);
        this.slotIndexData = new Uint32Array(n);
        this.layerData = new Uint32Array(n);
        this.instanceModelIds = new Uint8Array(n);
        this.instanceHandles = new Array(n).fill(null);
        this.materialIds = new Uint16Array(n * MAX_MATERIALS_PER_INSTANCE);
        this.materialCount = new Uint8Array(n);
        this.textureBGs = new Array(n).fill(null);
        this.instanceFlags = new Uint8Array(n).fill(0b11);
        this.lod = new InstanceLodStore(n);
        this.companions = new Int32Array(n).fill(-1);
        this.companionSlots = new SlotSet(n);
        this.slots = new SlotMap(n);
        this.batcher = new SparseBatcher(n);
    }

    textureBindGroup(slot: number): RawBindGroup | undefined {
        return this.textureBGs[slot] ?? undefined;
    }

    setTextureBindGroup(slot: number, bindGroup: RawBindGroup): void {
        this.textureBGs[slot] = bindGroup;
    }

    deleteTextureBindGroup(slot: number): void {
        this.textureBGs[slot] = null;
    }

    /** Whether a slot may be occlusion-culled by the depth pyramid. */
    occlusionEnabled(slot: number): boolean {
        return (this.instanceFlags[slot]! & 1) !== 0;
    }

    /** Render layer bit for a slot. */
    layerOf(slot: number): number {
        return this.layerData[slot] ?? 0;
    }

    /** Whether a slot contributes depth to the occluder pyramid. */
    occluderEnabled(slot: number): boolean {
        return (this.instanceFlags[slot]! & 2) !== 0;
    }

    /** Number of materials in a slot's list (0 if the slot is empty). */
    materialCountOf(slot: number): number {
        return this.materialCount[slot] ?? 0;
    }

    /** Material id at index `i` in a slot's list. */
    materialAt(slot: number, i: number): number {
        return this.materialIds[slot * MAX_MATERIALS_PER_INSTANCE + i] ?? 0;
    }

    /** Whether a slot's list contains `materialId`. */
    hasMaterial(slot: number, materialId: number): boolean {
        const k = slot * MAX_MATERIALS_PER_INSTANCE;
        const count = this.materialCount[slot] ?? 0;
        for (let i = 0; i < count; i++) if (this.materialIds[k + i] === materialId) return true;
        return false;
    }

    /** Append a material to a slot's list (no-op if present or full). */
    addMaterial(slot: number, modelId: number, materialId: number): void {
        if (this.hasMaterial(slot, materialId)) return;
        const count = this.materialCount[slot] ?? 0;
        if (count >= MAX_MATERIALS_PER_INSTANCE) return;
        this.materialIds[slot * MAX_MATERIALS_PER_INSTANCE + count] = materialId;
        this.materialCount[slot] = count + 1;
        this.batcher.add(materialId, modelId, slot);
        if (materialId > 0) this.deps.retainMaterial?.(materialId);
        this.dynamicVersion++;
    }

    /** Remove a material from a slot's list (falls back to the default when empty). */
    removeMaterial(slot: number, modelId: number, materialId: number): void {
        const k = slot * MAX_MATERIALS_PER_INSTANCE;
        const count = this.materialCount[slot] ?? 0;
        let idx = -1;
        for (let i = 0; i < count; i++) if (this.materialIds[k + i] === materialId) { idx = i; break; }
        if (idx < 0) return;
        this.batcher.remove(materialId, modelId, slot);
        if (materialId > 0) this.deps.releaseMaterial?.(materialId);
        for (let i = idx; i < count - 1; i++) this.materialIds[k + i] = this.materialIds[k + i + 1]!;
        let next = count - 1;
        if (next === 0) { this.materialIds[k] = 0; next = 1; this.batcher.add(0, modelId, slot); }
        this.materialCount[slot] = next;
        this.staticData[slot * STATIC_MESH_FLOATS + STAT_MATERIAL_ID] = this.materialIds[k]!;
        this.staticDirty = true;
        this.dynamicVersion++;
    }

    private setMaterialList(slot: number, modelId: number, materialIds: readonly number[]): void {
        const k = slot * MAX_MATERIALS_PER_INSTANCE;
        let count = 0;
        for (const m of materialIds) {
            if (count >= MAX_MATERIALS_PER_INSTANCE) break;
            let seen = false;
            for (let i = 0; i < count; i++) if (this.materialIds[k + i] === m) { seen = true; break; }
            if (seen) continue;
            this.materialIds[k + count++] = m;
        }
        if (count === 0) { this.materialIds[k] = 0; count = 1; }
        this.materialCount[slot] = count;
        for (let i = 0; i < count; i++) {
            const m = this.materialIds[k + i]!;
            this.batcher.add(m, modelId, slot);
            if (m > 0) this.deps.retainMaterial?.(m);
        }
    }

    /** Allocate a slot, write the initial transform, and return a live handle. */
    spawn(opts: MeshInstanceOptions<any>, modelHandle: ModelHandle, userPrefabId: string | null, id: number, materialIds: readonly number[] = [0]): MeshInstanceHandle {
        const slot = this.slots.add();
        if (slot === -1) throw new Error(`Max instances (${this.deps.maxInstances}) reached`);

        this.layerData[slot] = resolveRenderLayer(
            this.deps.layers,
            opts.renderLayer,
            (opts.prefab as { layer?: string } | undefined)?.layer,
        );

        let flags = 0;
        if (opts.occlusion !== false) flags |= 1;
        if (opts.occluder !== false) flags |= 2;
        this.instanceFlags[slot] = flags;

        const dynBase = slot * DYNAMIC_MESH_FLOATS;
        const statBase = slot * STATIC_MESH_FLOATS;
        const t = resolveTransform(opts);

        const dyn = this.dynamicData;
        const stat = this.staticData;

        dyn[dynBase + DYN_PREV_PX] = t.px;
        dyn[dynBase + DYN_PREV_PY] = t.py;
        dyn[dynBase + DYN_PREV_PZ] = t.pz;
        dyn[dynBase + DYN_CURR_PX] = t.px;
        dyn[dynBase + DYN_CURR_PY] = t.py;
        dyn[dynBase + DYN_CURR_PZ] = t.pz;

        dyn[dynBase + DYN_PREV_RX] = t.rx;
        dyn[dynBase + DYN_PREV_RY] = t.ry;
        dyn[dynBase + DYN_PREV_RZ] = t.rz;
        dyn[dynBase + DYN_CURR_RX] = t.rx;
        dyn[dynBase + DYN_CURR_RY] = t.ry;
        dyn[dynBase + DYN_CURR_RZ] = t.rz;

        stat[statBase + STAT_SX] = t.sx;
        stat[statBase + STAT_SY] = t.sy;
        stat[statBase + STAT_SZ] = t.sz;
        stat[statBase + STAT_CR] = t.cr;
        stat[statBase + STAT_CG] = t.cg;
        stat[statBase + STAT_CB] = t.cb;
        stat[statBase + STAT_MATERIAL_ID] = materialIds[0] ?? 0;
        stat[statBase + STAT_CUSTOM0] = 0;
        stat[statBase + STAT_CUSTOM1] = 0;

        this.staticDirty = true;
        this.dynamicVersion++;
        this.instanceModelIds[slot] = modelHandle.id;
        this.setMaterialList(slot, modelHandle.id, materialIds);

        const self = this;
        let destroyed = false;

        // Reusable tuples for the readonly getters. Mutated on each read; callers
        // must not retain the returned array across subsequent gets on the same handle.
        const posOut: [number, number, number] = [0, 0, 0];
        const rotOut: [number, number, number] = [0, 0, 0];
        const sclOut: [number, number, number] = [0, 0, 0];

        const initTexId = opts.texture
            ? (typeof opts.texture === 'string' ? opts.texture : (opts.texture as TexturePrefab).id)
            : null;

        let currentTexId: string | null = initTexId;

        const handle: MeshInstanceHandle = {
            id: id as MeshInstanceHandle['id'],
            get alive() { return !destroyed; },
            slot,
            modelId: modelHandle.id,
            skinned: false,
            prefabId: userPrefabId,
            materials: EMPTY_MATERIALS,
            get textureId() { return currentTexId; },
            get lodLevel() { return self.lod.levelOf(slot); },
            setPosition(nx: number, ny: number, nz: number) {
                dyn[dynBase + DYN_CURR_PX] = nx;
                dyn[dynBase + DYN_CURR_PY] = ny;
                dyn[dynBase + DYN_CURR_PZ] = nz;
                self.dynamicVersion++;
            },
            setRotation(nx: number, ny: number, nz: number) {
                dyn[dynBase + DYN_CURR_RX] = nx;
                dyn[dynBase + DYN_CURR_RY] = ny;
                dyn[dynBase + DYN_CURR_RZ] = nz;
                self.dynamicVersion++;
            },
            setScale(nx: number, ny: number, nz: number) {
                stat[statBase + STAT_SX] = nx;
                stat[statBase + STAT_SY] = ny;
                stat[statBase + STAT_SZ] = nz;
                self.staticDirty = true;
                self.dynamicVersion++;
            },
            teleport(nx: number, ny: number, nz: number) {
                dyn[dynBase + DYN_PREV_PX] = nx;
                dyn[dynBase + DYN_PREV_PY] = ny;
                dyn[dynBase + DYN_PREV_PZ] = nz;
                dyn[dynBase + DYN_CURR_PX] = nx;
                dyn[dynBase + DYN_CURR_PY] = ny;
                dyn[dynBase + DYN_CURR_PZ] = nz;
                self.dynamicVersion++;
            },
            get position(): readonly [number, number, number] {
                posOut[0] = dyn[dynBase + DYN_CURR_PX];
                posOut[1] = dyn[dynBase + DYN_CURR_PY];
                posOut[2] = dyn[dynBase + DYN_CURR_PZ];
                return posOut;
            },
            get rotation(): readonly [number, number, number] {
                rotOut[0] = dyn[dynBase + DYN_CURR_RX];
                rotOut[1] = dyn[dynBase + DYN_CURR_RY];
                rotOut[2] = dyn[dynBase + DYN_CURR_RZ];
                return rotOut;
            },
            get scale(): readonly [number, number, number] {
                sclOut[0] = stat[statBase + STAT_SX];
                sclOut[1] = stat[statBase + STAT_SY];
                sclOut[2] = stat[statBase + STAT_SZ];
                return sclOut;
            },
            setTexture(tex: string | TexturePrefab | null) {
                if (tex == null) {
                    self.textureBGs[slot] = null;
                    currentTexId = null;
                } else {
                    const texId = typeof tex === 'string' ? tex : tex.id;
                    const bindGroup = self.deps.getTextureBindGroup(texId);
                    if (bindGroup) {
                        self.textureBGs[slot] = bindGroup;
                        currentTexId = texId;
                    }
                }
            },
            setMaterial(next: number) {
                if (destroyed) return;
                const k = slot * MAX_MATERIALS_PER_INSTANCE;
                const count = self.materialCount[slot]!;
                if (count === 1 && self.materialIds[k] === next) return;
                for (let i = 0; i < count; i++) {
                    const m = self.materialIds[k + i]!;
                    self.batcher.remove(m, modelHandle.id, slot);
                    if (m > 0) self.deps.releaseMaterial?.(m);
                }
                self.materialIds[k] = next;
                self.materialCount[slot] = 1;
                self.batcher.add(next, modelHandle.id, slot);
                if (next > 0) self.deps.retainMaterial?.(next);
                stat[statBase + STAT_MATERIAL_ID] = next;
                self.staticDirty = true;
            },
            setMaterialParams(a: number, b: number) {
                stat[statBase + STAT_CUSTOM0] = a;
                stat[statBase + STAT_CUSTOM1] = b;
                self.staticDirty = true;
            },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                self.dynamicVersion++;
                self.textureBGs[slot] = null;
                const k = slot * MAX_MATERIALS_PER_INSTANCE;
                const count = self.materialCount[slot]!;
                for (let i = 0; i < count; i++) {
                    const m = self.materialIds[k + i]!;
                    self.batcher.remove(m, modelHandle.id, slot);
                    if (m > 0) self.deps.releaseMaterial?.(m);
                }
                self.materialCount[slot] = 0;
                self.instanceFlags[slot] = 0;
                self.lod.clear(slot);
                self.slots.remove(slot);
                dyn.fill(0, dynBase, dynBase + DYNAMIC_MESH_FLOATS);
                stat.fill(0, statBase, statBase + STATIC_MESH_FLOATS);
                self.layerData[slot] = 0;
                self.instanceHandles[slot] = null;
                self.staticDirty = true;
            },
        };
        this.instanceHandles[slot] = handle;

        if (initTexId) {
            const bindGroup = this.deps.getTextureBindGroup(initTexId);
            if (bindGroup) this.textureBGs[slot] = bindGroup;
        }

        return handle;
    }

    /** Attach LOD levels to a slot (near -> far; level 0 is the spawned model). */
    setLodLevels(opts: {
        slot: number;
        modelIds: readonly number[];
        distSq: readonly number[];
    }): void {
        if (opts.modelIds.length < 2) return;
        this.lod.setLevels(opts);
        this.instanceModelIds[opts.slot] = opts.modelIds[0]!;
    }

    /** The slot's current LOD level (0 when it has no LOD chain). */
    lodLevelOf(slot: number): number {
        return this.lod.levelOf(slot);
    }

    /** Move an instance to another model, relocating it in the batcher. */
    swapModel(slot: number, newModelId: number): void {
        const old = this.instanceModelIds[slot]!;
        if (old === newModelId) return;
        const k = slot * MAX_MATERIALS_PER_INSTANCE;
        const count = this.materialCount[slot] ?? 0;
        for (let i = 0; i < count; i++) this.batcher.remove(this.materialIds[k + i]!, old, slot);
        for (let i = 0; i < count; i++) this.batcher.add(this.materialIds[k + i]!, newModelId, slot);
        this.instanceModelIds[slot] = newModelId;
        this.dynamicVersion++;
    }

    /**
     * Select a level per LOD instance from the camera position, swapping the
     * batcher bucket only on change (`bias` scales distances, `hysteresis` is the
     * anti-flicker band). Returns the number of level swaps.
     */
    selectLod(camX: number, camY: number, camZ: number, bias = 1, hysteresis = 0.1): number {
        return this.lod.select(this.dynamicData, camX, camY, camZ, bias, hysteresis, this.applyModelSwap, this.beginFadeCb);
    }

    private readonly applyModelSwap = (slot: number, modelId: number): void => {
        this.swapModel(slot, modelId);
    };

    private readonly beginFadeCb = (slot: number, modelId: number): number => this.beginCompanion(slot, modelId);
    private readonly endFadeCb = (slot: number, companion: number): void => this.endCompanion(slot, companion);

    /** Spawn a hidden companion instance at `modelId` that mirrors `slot`. */
    private beginCompanion(slot: number, modelId: number): number {
        const c = this.slots.add();
        if (c === -1) return -1;
        const dyn = this.dynamicData;
        const stat = this.staticData;
        const sDyn = slot * DYNAMIC_MESH_FLOATS, cDyn = c * DYNAMIC_MESH_FLOATS;
        for (let i = 0; i < DYNAMIC_MESH_FLOATS; i++) dyn[cDyn + i] = dyn[sDyn + i]!;
        const sStat = slot * STATIC_MESH_FLOATS, cStat = c * STATIC_MESH_FLOATS;
        for (let i = 0; i < STATIC_MESH_FLOATS; i++) stat[cStat + i] = stat[sStat + i]!;
        this.instanceModelIds[c] = modelId;
        this.instanceFlags[c] = this.instanceFlags[slot]!;
        this.layerData[c] = this.layerData[slot]!;
        const kS = slot * MAX_MATERIALS_PER_INSTANCE;
        const kC = c * MAX_MATERIALS_PER_INSTANCE;
        const count = this.materialCount[slot] ?? 0;
        this.materialCount[c] = count;
        for (let i = 0; i < count; i++) {
            const m = this.materialIds[kS + i]!;
            this.materialIds[kC + i] = m;
            this.batcher.add(m, modelId, c);
        }
        // Inherit the slot's texture override so both levels sample the same map.
        this.textureBGs[c] = this.textureBGs[slot] ?? null;
        this.companions[slot] = c;
        this.companionSlots.add(slot);
        this.staticDirty = true;
        return c;
    }

    /** Free a fade companion. */
    private endCompanion(slot: number, c: number): void {
        const kC = c * MAX_MATERIALS_PER_INSTANCE;
        const count = this.materialCount[c] ?? 0;
        const modelId = this.instanceModelIds[c]!;
        for (let i = 0; i < count; i++) this.batcher.remove(this.materialIds[kC + i]!, modelId, c);
        this.materialCount[c] = 0;
        const cDyn = c * DYNAMIC_MESH_FLOATS, cStat = c * STATIC_MESH_FLOATS;
        this.dynamicData.fill(0, cDyn, cDyn + DYNAMIC_MESH_FLOATS);
        this.staticData.fill(0, cStat, cStat + STATIC_MESH_FLOATS);
        this.instanceHandles[c] = null;
        this.textureBGs[c] = null;
        this.instanceFlags[c] = 0;
        this.layerData[c] = 0;
        this.slots.remove(c);
        this.companions[slot] = -1;
        this.companionSlots.remove(slot);
        this.staticDirty = true;
    }

    /** Mirror each companion's transform from its main slot (morph excluded). O(companions). */
    syncCompanions(): void {
        const size = this.companionSlots.size;
        if (size === 0) return;
        const dyn = this.dynamicData;
        const active = this.companionSlots.denseBuffer;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            const c = this.companions[slot]!;
            const sDyn = slot * DYNAMIC_MESH_FLOATS, cDyn = c * DYNAMIC_MESH_FLOATS;
            for (let k = 0; k < DYN_MORPH; k++) dyn[cDyn + k] = dyn[sDyn + k]!;
        }
    }

    /** Advance in-progress LOD geomorphs by one tick (no-op when `lod.fadeTicks` is 0). */
    advanceFades(): void {
        this.lod.advanceFades(this.dynamicData, this.applyModelSwap, this.endFadeCb);
    }

    /** Remove `materialId` from every instance using it (falls back to default). */
    reassignMaterial(materialId: number): void {
        if (materialId <= 0) return;
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            if (this.hasMaterial(slot, materialId)) this.removeMaterial(slot, this.instanceModelIds[slot]!, materialId);
        }
    }

    /** Copy CURR -> PREV for every live non-skinned instance. */
    storePrevious(): void {
        const dyn = this.dynamicData;
        this.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const base = instances[i] * DYNAMIC_MESH_FLOATS;
                dyn[base + DYN_PREV_PX] = dyn[base + DYN_CURR_PX];
                dyn[base + DYN_PREV_PY] = dyn[base + DYN_CURR_PY];
                dyn[base + DYN_PREV_PZ] = dyn[base + DYN_CURR_PZ];
                dyn[base + DYN_PREV_RX] = dyn[base + DYN_CURR_RX];
                dyn[base + DYN_PREV_RY] = dyn[base + DYN_CURR_RY];
                dyn[base + DYN_PREV_RZ] = dyn[base + DYN_CURR_RZ];
            }
        });
    }
}

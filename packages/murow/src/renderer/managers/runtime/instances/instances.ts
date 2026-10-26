import { PooledCollection } from 'murow/core/collection';
import type { Interpolator } from '../types';
import type { InstanceId } from '../ids';
import type { Logger } from 'murow/core';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { Hitbox } from 'murow/core/hitbox';
import type { PlayOptions, Prefab3D, TexturePrefab, PrefabBucket3D, CompositePrefab } from 'murow/renderer';
import { DYNAMIC_MESH_FLOATS, STATIC_MESH_FLOATS, SKINNED_STATIC_MESH_FLOATS } from '../engine-core/types';
import type { GltfModel, LodSpec, MeshInstanceHandle, MeshInstanceOptions, ModelHandle } from '../types';
import type { Handles } from '../handles';
import type { MaterialHandle } from '../materials';
import type { ModelLibrary } from '../internals/model-library';
import type { Frustum } from '../internals/frustum';
import { resolveRenderLayer, visibleTo, type LayerRegistry } from '../../../layers';
import { InstanceStore } from './instance-store';
import { SkinnedInstanceStore, type SkinModelLike } from './skinned-instance-store';
import { isPrefab3D, resolvePrefabHandle } from './prefab-handle';
import type { OcclusionBatch } from '../backend';
import {
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    STAT_SX, STAT_SY, STAT_SZ,
    SSTAT_SX, SSTAT_SY, SSTAT_SZ,
} from './offsets';

export { setPrefabHandle } from './prefab-handle';

/**
 * The renderer surface an instance needs. Only models, prefabs and the two
 * stores are required; no peer manager is reached through the renderer.
 */
export interface InstanceManagerDeps {
    /** Public capacity (non-skinned slots). */
    capacity: number;
    /** Combined identity pool size (non-skinned + skinned). */
    poolSize: number;
    logger: Logger;
    store: InstanceStore;
    skinned: SkinnedInstanceStore;
    models: ModelLibrary;
    prefabs: PrefabBucket3D | null;
    /** Layer registry used to resolve per-instance render layers. */
    layers: LayerRegistry;
    /** Upper bound on distinct skin indices; sizes the free-offset table. */
    getSkinModel(index: number): SkinModelLike | undefined;
    /** Registered name of a 1-based material id, for the `materials` view. */
    materialName?(id: number): string | undefined;
}

/** One draw target a material view can add/remove materials on. */
interface MaterialTarget {
    count(): number;
    at(i: number): number;
    has(id: number): boolean;
    add(id: number): void;
    remove(id: number): void;
}

/** Normalize `material`/`materials` options into a list of 1-based material ids. */
function materialIdsFromOptions(opts: MeshInstanceOptions<any>): number[] {
    const out: number[] = [];
    const push = (m: MaterialHandle<any, any> | undefined | null) => {
        if (!m) return;
        const id = m.slot + 1;
        if (!out.includes(id)) out.push(id);
    };
    const materials = opts.materials;
    if (Array.isArray(materials)) {
        for (const m of materials) push(m as MaterialHandle<any, any>);
    } else if (materials && typeof materials === 'object') {
        for (const m of Object.values(materials)) push(m as MaterialHandle<any, any>);
    }
    push(opts.material);
    if (out.length === 0) out.push(0);
    return out;
}

/** A visible non-skinned batch the main pass draws (one model + material). */
export interface MainPassBatch {
    modelId: number;
    materialId: number;
    offset: number;
    count: number;
    /** Draw directly, bypassing the occlusion indirect args for this batch. */
    forceDirect?: boolean;
}

/** A visible skinned batch the main pass draws. */
export interface SkinnedMainPassBatch {
    modelId: number;
    offset: number;
    count: number;
}

/**
 * InstanceManager owns the pooled instance identity space (non-skinned and
 * skinned) and the multi-part prefab spawn logic. It is a facade over
 * `InstanceStore`, `SkinnedInstanceStore` and `ModelLibrary`.
 */
export class InstanceManager extends PooledCollection<InstanceId, MeshInstanceHandle, number> implements Interpolator {
    private readonly deps: InstanceManagerDeps;
    private readonly rawHandles: (MeshInstanceHandle | null)[];
    private readonly origDestroy: (((...args: never[]) => void) | null)[];
    private pending:
        | { kind: 'static'; opts: MeshInstanceOptions<any>; modelHandle: ModelHandle; prefabId: string | null; materialIds: number[] }
        | { kind: 'skinned'; opts: MeshInstanceOptions<any>; modelHandle: ModelHandle; skinIndex: number; skinModel: SkinModelLike; linkedSlot: number | undefined; prefabId: string | null; materialIds: number[] }
        | null = null;

    /** @internal Visible non-skinned batches for the main pass; first `batchCount` entries. */
    readonly batchOffsets: MainPassBatch[] = [];
    /** @internal Number of valid entries in `batchOffsets`. */
    batchCount = 0;
    /** @internal Visible skinned batches for the main pass; first `skinnedBatchCount` entries. */
    readonly skinnedBatchOffsets: SkinnedMainPassBatch[] = [];
    /** @internal Number of valid entries in `skinnedBatchOffsets`. */
    skinnedBatchCount = 0;
    /** @internal Non-skinned slot indices packed by `prepareFrame`. */
    slotIndexCount = 0;
    /** @internal Skinned slot indices packed by `prepareFrame`. */
    skinnedSlotIndexCount = 0;
    /**
     * @internal Occlusion candidate batches gathered by `prepareFrame`; the
     * first `occlusionBatchCount` entries are valid. Handed to the optional
     * occlusion port.
     */
    readonly occlusionBatches: OcclusionBatch[] = [];
    /** @internal Number of valid entries in `occlusionBatches`. */
    occlusionBatchCount = 0;
    /** Pooled batch records, reused so `prepareFrame` stays allocation-free. */
    private readonly occlusionBatchPool: OcclusionBatch[] = [];

    /** @internal Skinned occlusion candidate batches, mirroring the above. */
    readonly skinnedOcclusionBatches: OcclusionBatch[] = [];
    /** @internal Number of valid entries in `skinnedOcclusionBatches`. */
    skinnedOcclusionBatchCount = 0;
    private readonly skinnedOcclusionBatchPool: OcclusionBatch[] = [];

    /** LOD: master switch. When false, every instance stays on level 0. */
    lodEnabled = true;
    /** LOD: distance multiplier applied to every authored level distance. */
    lodBias = 1;
    /** LOD: fractional band that must be crossed before a level change. */
    lodHysteresis = 0.1;
    /** LOD geomorph fade length in ticks (0 = hard switch). Set by the renderer. */
    lodFadeTicks = 0;

    constructor(deps: InstanceManagerDeps) {
        super({ poolSize: deps.poolSize, capacity: deps.capacity, logger: deps.logger, name: 'instances' });
        this.deps = deps;
        this.rawHandles = new Array(deps.poolSize).fill(null);
        this.origDestroy = new Array(deps.poolSize).fill(null);
    }

    /** The non-skinned store, read by the renderer's pass sequencing. */
    get store(): InstanceStore {
        return this.deps.store;
    }

    /** The skinned store, read by the renderer's pass sequencing. */
    get skinnedStore(): SkinnedInstanceStore {
        return this.deps.skinned;
    }

    /**
     * Add an instance. For skinned models, pass `linkedTo` to share bone
     * matrices with another instance (e.g. when spawning all parts of a
     * character).
     * @returns the instance handle. Throws when a pool is full.
     */
    add(opts: MeshInstanceOptions<any>): MeshInstanceHandle {
        const rawModel: ModelHandle | GltfModel | Prefab3D | string = opts.prefab as never;

        let prefab: Prefab3D | undefined;
        let resolvedOpts = opts;
        if (typeof rawModel === 'string') {
            prefab = this.deps.prefabs?.get(rawModel) as unknown as Prefab3D | undefined;
            if (!prefab) throw new Error(`instances.add: prefab '${rawModel}' not found`);
            resolvedOpts = { ...opts, prefab };
        } else if (isPrefab3D(rawModel)) {
            prefab = rawModel;
        }

        const userPrefabId = prefab ? prefab.id : null;
        const materialIds = materialIdsFromOptions(resolvedOpts);

        const prefabLayer = (prefab as { layer?: string } | undefined)?.layer;
        resolvedOpts = {
            ...resolvedOpts,
            renderLayer: resolveRenderLayer(this.deps.layers, resolvedOpts.renderLayer, prefabLayer),
        };

        // LOD: explicit per-instance chain wins; else inherit the prefab's.
        let lods: readonly LodSpec[] | undefined = Array.isArray(resolvedOpts.lod) ? resolvedOpts.lod : undefined;
        const prefabLods = prefab === undefined ? undefined : (prefab as unknown as { lods?: readonly LodSpec[] }).lods;
        if (lods === undefined && Array.isArray(prefabLods)) lods = prefabLods;

        if (prefab?.type === 'composite') {
            return this.addComposite(resolvedOpts, prefab, lods);
        }

        const resolved = prefab ? resolvePrefabHandle(prefab) : resolvedOpts.prefab;

        if ('parts' in (resolved as ModelHandle | GltfModel)) {
            return this.addGltf(resolvedOpts, resolved as GltfModel, userPrefabId, materialIds, lods);
        }

        const modelHandle = resolved as ModelHandle;
        const model = this.deps.models.get(modelHandle.id);

        if (model?.skinned) {
            return this.spawnSkinned(resolvedOpts, modelHandle, model.skinIndex, undefined, userPrefabId, materialIds, lods);
        }

        return this.spawnStatic(resolvedOpts, modelHandle, userPrefabId, materialIds, lods);
    }

    /** Live non-skinned instances. */
    get count(): number {
        return this.deps.store.slots.size;
    }

    /** Non-skinned instance capacity. */
    get capacity(): number {
        return this.deps.store.slots.capacity;
    }

    /** Live skinned instances. */
    get skinnedCount(): number {
        return this.deps.skinned.slots.size;
    }

    /** Skinned instance capacity. */
    get skinnedCapacity(): number {
        return this.deps.skinned.slots.capacity;
    }

    /** Live instances across both pools. */
    get totalCount(): number {
        return this.deps.store.slots.size + this.deps.skinned.slots.size;
    }

    /** Capacity across both pools. */
    get totalCapacity(): number {
        return this.deps.store.slots.capacity + this.deps.skinned.slots.capacity;
    }

    /**
     * Snapshot curr -> prev for every live instance (non-skinned and skinned).
     * @internal Called by the renderer's pre-tick, not for direct user calls.
     */
    storePrevious(): void {
        this.deps.store.storePrevious();
        this.deps.skinned.storePrevious();
    }

    /** Reset every instance using a 1-based material id back to the default. */
    reassignMaterial(materialId: number): void {
        this.deps.store.reassignMaterial(materialId);
        this.deps.skinned.reassignMaterial(materialId);
    }

    /**
     * Pick a level per LOD instance from the camera position, swapping batcher
     * buckets only on change. Call once per frame (or tick) before
     * `prepareFrame`.
     * @returns the number of level swaps.
     * @internal
     */
    selectLod(
        camX: number,
        camY: number,
        camZ: number,
        bias = this.lodBias,
        hysteresis = this.lodHysteresis,
        enabled = this.lodEnabled,
    ): number {
        if (!enabled) return 0;
        this.deps.store.lod.fadeTicks = this.lodFadeTicks;
        const swaps =
            this.deps.store.selectLod(camX, camY, camZ, bias, hysteresis) +
            this.deps.skinned.selectLod(camX, camY, camZ, bias, hysteresis);
        this.deps.store.advanceFades();
        return swaps;
    }

    /**
     * Pair each level's model with the next level's vertex buffer for GPU
     * geomorph. Correspondence between the two levels is the asset author's
     * responsibility; the engine does not check or require it.
     */
    private pairMorphTargets(modelIds: readonly number[]): void {
        for (let i = 0; i + 1 < modelIds.length; i++) {
            const a = this.deps.models.get(modelIds[i]!);
            const b = this.deps.models.get(modelIds[i + 1]!);
            if (a) a.morphVertexBuffer = b ? b.rawVertexBuffer : null;
        }
    }

    /** Attach a single-mesh LOD chain to a freshly spawned non-skinned slot. */
    private applyLod(slot: number, baseModelId: number, lods: readonly LodSpec[]): void {
        const chain = this.buildLodChains([baseModelId], lods);
        const modelIds = chain.levelPartIds.map((lp) => lp[0]!);
        this.pairMorphTargets(modelIds);
        this.deps.store.setLodLevels({ slot, modelIds, distSq: chain.distSq });
    }

    /** Attach a single-mesh LOD chain to a freshly spawned skinned slot. */
    private applySkinnedLod(slot: number, baseModelId: number, lods: readonly LodSpec[]): void {
        const chain = this.buildLodChains([baseModelId], lods);
        this.deps.skinned.setLodLevels({ slot, modelIds: chain.levelPartIds.map((lp) => lp[0]!), distSq: chain.distSq });
    }

    /**
     * Gather, frustum-cull and pack the visible batches for the main pass. The
     * renderer uploads the resulting slot indices and reads the batch lists.
     *
     * Occlusion candidates mirror the frustum-visible set: every visible slot
     * is a candidate and the per-slot `occlusion` flag is consumed by the
     * occlusion port, which keeps non-cullable instances in its output.
     * @internal
     */
    prepareFrame(frustum: Frustum, mask: number = 0xffffffff): void {
        const store = this.deps.store;
        // Mirror active LOD fade companions from their main instances first.
        store.syncCompanions();
        const skinned = this.deps.skinned;
        const models = this.deps.models;

        this.occlusionBatches.length = 0;
        let occlusionCount = 0;
        let indexOffset = 0;
        let batchCount = 0;
        const dyn = store.dynamicData;
        const stat = store.staticData;
        store.batcher.each((modelId, instances, count, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            const model = models.get(modelId);
            if (!model) return;
            const baseRadius = model.boundingRadius;
            let forceVisible = false;
            const batchStart = indexOffset;
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * STATIC_MESH_FLOATS;
                const cx = dyn[base + DYN_CURR_PX];
                const cy = dyn[base + DYN_CURR_PY];
                const cz = dyn[base + DYN_CURR_PZ];
                const sx = stat[sBase + STAT_SX];
                const sy = stat[sBase + STAT_SY];
                const sz = stat[sBase + STAT_SZ];
                const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                const radius = baseRadius * maxScale;
                if (!visibleTo(store.layerData[slot]!, mask)) continue;
                if (frustum.intersectsSphere(cx, cy, cz, radius)) {
                    if (!store.occlusionEnabled(slot)) forceVisible = true;
                    store.slotIndexData[indexOffset++] = slot;
                }
            }
            const visibleCount = indexOffset - batchStart;
            if (visibleCount > 0) {
                const batch = this.nonSkinnedBatchAt(batchCount++);
                batch.modelId = modelId;
                batch.materialId = materialId;
                batch.offset = batchStart;
                batch.count = visibleCount;
                batch.forceDirect = forceVisible;

                const occ = this.occlusionBatchAt(occlusionCount++);
                occ.modelId = modelId;
                occ.candidateOffset = batchStart;
                occ.candidateCount = visibleCount;
                occ.outputOffset = batchStart;
                occ.indexCount = model.indexCount;
                occ.forceVisible = forceVisible;
                this.occlusionBatches.push(occ);
            }
        });
        this.batchCount = batchCount;
        this.slotIndexCount = indexOffset;
        this.occlusionBatchCount = occlusionCount;

        let skinnedIndexOffset = 0;
        let skinnedBatchCount = 0;
        this.skinnedOcclusionBatches.length = 0;
        let skinnedOccCount = 0;
        const sDyn = skinned.dynamicData;
        const sStat = skinned.staticData;
        skinned.batcher.each((modelId, instances, count) => {
            const model = models.get(modelId);
            if (!model) return;
            const batchStart = skinnedIndexOffset;
            const skinModel = model.skinIndex >= 0 ? models.skinnedModel(model.skinIndex) : null;
            const baseRadius = skinModel?.boundingRadius ?? 10;
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * SKINNED_STATIC_MESH_FLOATS;
                const cx = sDyn[base + DYN_CURR_PX];
                const cy = sDyn[base + DYN_CURR_PY];
                const cz = sDyn[base + DYN_CURR_PZ];
                const sx = sStat[sBase + SSTAT_SX];
                const sy = sStat[sBase + SSTAT_SY];
                const sz = sStat[sBase + SSTAT_SZ];
                const maxScale = Math.abs(sx) > Math.abs(sy) ? (Math.abs(sx) > Math.abs(sz) ? Math.abs(sx) : Math.abs(sz)) : (Math.abs(sy) > Math.abs(sz) ? Math.abs(sy) : Math.abs(sz));
                const radius = baseRadius * maxScale;
                if (!visibleTo(skinned.layerData[slot]!, mask)) continue;
                if (frustum.intersectsSphere(cx, cy, cz, radius)) {
                    skinned.slotIndexData[skinnedIndexOffset++] = slot;
                }
            }
            const visibleCount = skinnedIndexOffset - batchStart;
            if (visibleCount > 0) {
                const batch = this.skinnedBatchAt(skinnedBatchCount++);
                batch.modelId = modelId;
                batch.offset = batchStart;
                batch.count = visibleCount;

                const occ = this.skinnedOcclusionBatchAt(skinnedOccCount++);
                occ.modelId = modelId;
                occ.candidateOffset = batchStart;
                occ.candidateCount = visibleCount;
                occ.outputOffset = batchStart;
                occ.indexCount = model.indexCount;
                this.skinnedOcclusionBatches.push(occ);
            }
        });
        this.skinnedBatchCount = skinnedBatchCount;
        this.skinnedSlotIndexCount = skinnedIndexOffset;
        this.skinnedOcclusionBatchCount = skinnedOccCount;
    }

    /**
     * Visit every live instance (non-skinned and skinned) with its world
     * position, scale and model half-extents.
     * @internal
     */
    eachInstance(
        visit: (
            handle: MeshInstanceHandle,
            cx: number, cy: number, cz: number,
            sx: number, sy: number, sz: number,
            halfX: number, halfY: number, halfZ: number,
            centerX: number, centerY: number, centerZ: number,
        ) => void,
    ): void {
        const models = this.deps.models;
        const store = this.deps.store;
        const dyn = store.dynamicData;
        const stat = store.staticData;
        store.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = store.instanceHandles[slot];
                if (handle === null) continue;
                const model = models.get(handle.modelId);
                if (!model) continue;
                const dynBase = slot * DYNAMIC_MESH_FLOATS;
                const statBase = slot * STATIC_MESH_FLOATS;
                visit(handle,
                    dyn[dynBase + DYN_CURR_PX], dyn[dynBase + DYN_CURR_PY], dyn[dynBase + DYN_CURR_PZ],
                    stat[statBase + STAT_SX], stat[statBase + STAT_SY], stat[statBase + STAT_SZ],
                    model.halfX, model.halfY, model.halfZ,
                    model.centerX, model.centerY, model.centerZ);
            }
        });

        const skinned = this.deps.skinned;
        const sDyn = skinned.dynamicData;
        const sStat = skinned.staticData;
        skinned.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = skinned.instanceHandles[slot];
                if (handle === null) continue;
                const model = models.get(handle.modelId);
                if (!model) continue;
                const skin = models.skinnedModel(model.skinIndex);
                if (!skin) continue;
                const dynBase = slot * DYNAMIC_MESH_FLOATS;
                const statBase = slot * SKINNED_STATIC_MESH_FLOATS;
                visit(handle,
                    sDyn[dynBase + DYN_CURR_PX], sDyn[dynBase + DYN_CURR_PY], sDyn[dynBase + DYN_CURR_PZ],
                    sStat[statBase + SSTAT_SX], sStat[statBase + SSTAT_SY], sStat[statBase + SSTAT_SZ],
                    model.halfX, model.halfY, model.halfZ,
                    model.centerX, model.centerY, model.centerZ);
            }
        });
    }

    /**
     * Render layer bit of an instance.
     * @internal
     */
    layerOf(handle: MeshInstanceHandle): number {
        return handle.skinned ? this.deps.skinned.layerOf(handle.slot) : this.deps.store.layerOf(handle.slot);
    }

    /**
     * Resolve an instance's declared hitbox name to its Hitbox via the bucket's
     * library, falling back to `null` (the model AABB).
     * @internal
     */
    resolveHitbox(handle: MeshInstanceHandle): Hitbox<'3d'> | null {
        const prefabs = this.deps.prefabs;
        if (!prefabs || !handle.prefabId) return null;
        const lib = prefabs.hitboxLibrary;
        if (!lib) return null;
        const prefab = prefabs.get(handle.prefabId) as unknown as Prefab3D | undefined;
        const name = prefab?.hitbox;
        return name ? (lib.get(name as never) as Hitbox<'3d'>) : null;
    }

    private nonSkinnedBatchAt(index: number): MainPassBatch {
        let batch = this.batchOffsets[index];
        if (batch === undefined) {
            batch = { modelId: 0, materialId: 0, offset: 0, count: 0 };
            this.batchOffsets[index] = batch;
        }
        return batch;
    }

    private skinnedBatchAt(index: number): SkinnedMainPassBatch {
        let batch = this.skinnedBatchOffsets[index];
        if (batch === undefined) {
            batch = { modelId: 0, offset: 0, count: 0 };
            this.skinnedBatchOffsets[index] = batch;
        }
        return batch;
    }

    /** Reuse a pooled occlusion batch record so the frame path allocates nothing. */
    private occlusionBatchAt(index: number): OcclusionBatch {
        let batch = this.occlusionBatchPool[index];
        if (batch === undefined) {
            batch = { modelId: 0, candidateOffset: 0, candidateCount: 0, outputOffset: 0, indexCount: 0 };
            this.occlusionBatchPool[index] = batch;
        }
        return batch;
    }

    /** Pooled record for a skinned occlusion batch. */
    private skinnedOcclusionBatchAt(index: number): OcclusionBatch {
        let batch = this.skinnedOcclusionBatchPool[index];
        if (batch === undefined) {
            batch = { modelId: 0, candidateOffset: 0, candidateCount: 0, outputOffset: 0, indexCount: 0 };
            this.skinnedOcclusionBatchPool[index] = batch;
        }
        return batch;
    }

    protected destroySlot(slot: number): void {
        this.origDestroy[slot]?.();
        this.origDestroy[slot] = null;
        this.rawHandles[slot] = null;
    }

    protected createItem(id: InstanceId, slot: number): MeshInstanceHandle {
        const p = this.pending!;
        const raw = p.kind === 'skinned'
            ? this.deps.skinned.spawn(p.opts, p.modelHandle, p.skinIndex, p.skinModel, p.linkedSlot, p.prefabId, p.materialIds, id)
            : this.deps.store.spawn(p.opts, p.modelHandle, p.prefabId, id, p.materialIds);
        return this.installHandle(id, slot, raw);
    }

    private installHandle(id: InstanceId, slot: number, raw: MeshInstanceHandle): MeshInstanceHandle {
        this.rawHandles[slot] = raw;
        const orig = raw.destroy.bind(raw);
        this.origDestroy[slot] = orig;
        Object.defineProperty(raw, 'alive', { configurable: true, get: () => this.has(id) });
        raw.destroy = () => this.remove(id);
        raw.materials = this.makeMaterialsView([this.materialTarget(raw)]);
        return raw;
    }

    /** Build a `MaterialTarget` adapter over a store handle. */
    private materialTarget(handle: { slot: number; modelId: number; skinned: boolean }): MaterialTarget {
        const { slot, modelId, skinned } = handle;
        if (skinned) {
            const s = this.deps.skinned;
            return {
                count: () => s.materialCountOf(slot),
                at: (i) => s.materialAt(slot, i),
                has: (id) => s.hasMaterial(slot, id),
                add: (id) => s.addMaterial(slot, id),
                remove: (id) => s.removeMaterial(slot, id),
            };
        }
        const s = this.deps.store;
        return {
            count: () => s.materialCountOf(slot),
            at: (i) => s.materialAt(slot, i),
            has: (id) => s.hasMaterial(slot, id),
            add: (id) => s.addMaterial(slot, modelId, id),
            remove: (id) => s.removeMaterial(slot, modelId, id),
        };
    }

    /** Build an addressable material view over one or more draw targets. */
    private makeMaterialsView(targets: MaterialTarget[]): Handles.InstanceMaterials {
        const primary = targets[0]!;
        const nameOf = (id: number) => this.deps.materialName?.(id) ?? '';
        const resolve = (x: number | string): number | undefined => {
            if (typeof x === 'number') return primary.has(x) ? x : undefined;
            for (let i = 0; i < primary.count(); i++) {
                const id = primary.at(i);
                if (nameOf(id) === x) return id;
            }
            return undefined;
        };
        const refOf = (id: number): Handles.MaterialRef => ({
            materialId: id,
            name: nameOf(id),
            remove: () => { for (const t of targets) t.remove(id); },
        });
        return {
            get: (x) => { const id = resolve(x); return id === undefined ? undefined : refOf(id); },
            has: (x) => resolve(x) !== undefined,
            add: (m) => { const id = m.slot + 1; for (const t of targets) t.add(id); },
            remove: (x) => { const id = resolve(x); if (id !== undefined) for (const t of targets) t.remove(id); },
            get all() {
                const out: Handles.MaterialRef[] = [];
                for (let i = 0; i < primary.count(); i++) out.push(refOf(primary.at(i)));
                return out;
            },
        };
    }

    private spawnStatic(
        opts: MeshInstanceOptions<any>,
        modelHandle: ModelHandle,
        prefabId: string | null,
        materialIds: number[],
        lods: readonly LodSpec[] | undefined,
    ): MeshInstanceHandle | null {
        this.pending = { kind: 'static', opts, modelHandle, prefabId, materialIds };
        const item = this.allocateItem().item;
        this.pending = null;
        if (lods !== undefined && lods.length > 0) {
            this.applyLod(item.slot, modelHandle.id, lods);
        }
        return item;
    }

    private spawnSkinned(
        opts: MeshInstanceOptions<any>,
        modelHandle: ModelHandle,
        skinIndex: number,
        linkedSlot: number | undefined,
        prefabId: string | null,
        materialIds: number[],
        lods: readonly LodSpec[] | undefined,
    ): MeshInstanceHandle | null {
        const skinModel = this.deps.models.skinnedModel(skinIndex);
        if (!skinModel) throw new Error(`instances.add: skinned model (skin ${skinIndex}) not found`);
        this.pending = {
            kind: 'skinned', opts, modelHandle, skinIndex,
            skinModel: skinModel as unknown as SkinModelLike, linkedSlot, prefabId, materialIds,
        };
        const allocated = this.allocateItem();
        this.pending = null;
        if (allocated && lods !== undefined && lods.length > 0) {
            this.applySkinnedLod(allocated.item.slot, modelHandle.id, lods);
        }
        return allocated ? allocated.item : null;
    }

    /**
     * Model ids of a prefab's parts (one for a single-mesh prefab, N for a
     * multi-part glTF or a composite). Used to build matching-part LOD chains.
     */
    private collectPartModelIds(prefab: Prefab3D | string, out: number[]): boolean {
        const bucket = this.deps.prefabs;
        const p = typeof prefab === 'string'
            ? (bucket?.get(prefab) as unknown as Prefab3D | undefined)
            : prefab;
        if (!p) return false;
        if (p.type === 'composite') {
            if (!bucket) return false;
            for (const part of p.parts) {
                if (!this.collectPartModelIds(bucket.get(part.partId) as unknown as Prefab3D, out)) return false;
            }
            return true;
        }
        const r = resolvePrefabHandle(p);
        if ('parts' in (r as GltfModel)) {
            for (const part of (r as GltfModel).parts) out.push(part.id);
            return true;
        }
        out.push((r as ModelHandle).id);
        return true;
    }

    /**
     * Build matching-part LOD chains: level k's part i is `levelPartIds[k][i]`.
     * Throws if a level's part count differs from the base (matching structure
     * is required — levels are lower-detail versions of the same prefab).
     */
    private buildLodChains(basePartIds: number[], lods: readonly LodSpec[]): { levelPartIds: number[][]; distSq: number[] } {
        const levelPartIds: number[][] = [basePartIds];
        const distSq: number[] = [];
        for (const level of lods) {
            const parts: number[] = [];
            if (!this.collectPartModelIds(level.prefabId, parts) || parts.length !== basePartIds.length) {
                throw new Error(
                    `instances.add: LOD level '${level.prefabId}' has ${parts.length} part(s); the base has ${basePartIds.length}`,
                );
            }
            levelPartIds.push(parts);
            distSq.push(level.distance === undefined ? Infinity : level.distance * level.distance);
        }
        distSq.push(Infinity); // last level renders to the far plane
        this.assertMatchingSkeletons(levelPartIds);
        return { levelPartIds, distSq };
    }

    /** Skinned LOD levels must share the base part's skeleton (skin index). */
    private assertMatchingSkeletons(levelPartIds: number[][]): void {
        const base = levelPartIds[0]!;
        for (let k = 1; k < levelPartIds.length; k++) {
            const level = levelPartIds[k]!;
            for (let i = 0; i < base.length; i++) {
                const b = this.deps.models.get(base[i]!);
                const l = this.deps.models.get(level[i]!);
                const bSkinned = b?.skinned ?? false;
                if (bSkinned !== (l?.skinned ?? false)) {
                    throw new Error(`instances.add: LOD level part ${i} skinned=${l?.skinned ?? false} but the base is skinned=${bSkinned}`);
                }
                if (bSkinned && l?.skinIndex !== b?.skinIndex) {
                    throw new Error(`instances.add: skinned LOD level part ${i} uses skin ${l?.skinIndex} but the base uses skin ${b?.skinIndex}`);
                }
            }
        }
    }

    private addGltf(opts: MeshInstanceOptions<any>, gltf: GltfModel, prefabId: string | null, materialIds: number[], lods: readonly LodSpec[] | undefined): MeshInstanceHandle {
        const chains = lods !== undefined && lods.length > 0
            ? this.buildLodChains(gltf.parts.map((p) => p.id), lods)
            : null;
        const childHandles: MeshInstanceHandle[] = [];
        let firstSkinnedSlot: number | undefined;

        for (let i = 0; i < gltf.parts.length; i++) {
            const part = gltf.parts[i]!;
            const partOpts = { ...opts, prefab: part, lod: undefined };
            const model = this.deps.models.get(part.id);
            let handle: MeshInstanceHandle | null = null;
            if (model?.skinned) {
                handle = this.spawnSkinned(partOpts, part, model.skinIndex, firstSkinnedSlot, prefabId, materialIds, undefined);
                if (handle) {
                    if (firstSkinnedSlot === undefined) firstSkinnedSlot = handle.slot;
                    childHandles.push(handle);
                }
            } else {
                handle = this.spawnStatic(partOpts, part, prefabId, materialIds, undefined);
                if (handle) childHandles.push(handle);
            }
            if (handle !== null && chains !== null) {
                const modelIds = chains.levelPartIds.map((lp) => lp[i]!);
                if (!model?.skinned) this.pairMorphTargets(modelIds);
                const target = model?.skinned ? this.deps.skinned : this.deps.store;
                target.setLodLevels({ slot: handle.slot, modelIds, distSq: chains.distSq });
            }
        }

        if (childHandles.length === 0) {
            throw new Error(`instances.add: glTF '${gltf.src}' produced no parts`);
        }

        const skinnedHandle = childHandles.find((h) => h.skinned);
        const lead = childHandles[0]!;
        return this.groupHandle(childHandles, lead, gltf.skinned, prefabId, skinnedHandle);
    }

    private addComposite(opts: MeshInstanceOptions<any>, composite: CompositePrefab, lods: readonly LodSpec[] | undefined): MeshInstanceHandle {
        const bucket = this.deps.prefabs;
        if (!bucket) {
            throw new Error(
                `instances.add: composite '${composite.id}' requires the renderer to be constructed with the bucket.`,
            );
        }

        const basePos = opts.position ?? [0, 0, 0];
        const baseRot = opts.rotation ?? [0, 0, 0];
        const offsets = composite.parts.map((p) => ({
            px: p.offset?.position?.[0] ?? 0,
            py: p.offset?.position?.[1] ?? 0,
            pz: p.offset?.position?.[2] ?? 0,
            rx: p.offset?.rotation?.[0] ?? 0,
            ry: p.offset?.rotation?.[1] ?? 0,
            rz: p.offset?.rotation?.[2] ?? 0,
        }));

        // Nested LOD: each part's chain is the corresponding part of every level
        // composite, pushed down through `add` (works at any depth).
        let levelComposites: CompositePrefab[] | null = null;
        if (lods !== undefined && lods.length > 0) {
            levelComposites = [];
            for (const level of lods) {
                const p = bucket.get(level.prefabId) as unknown as Prefab3D;
                if (p.type !== 'composite' || p.parts.length !== composite.parts.length) {
                    throw new Error(
                        `instances.add: LOD level '${level.prefabId}' is not a composite with ${composite.parts.length} part(s)`,
                    );
                }
                levelComposites.push(p);
            }
        }

        const childHandles: MeshInstanceHandle[] = [];
        for (let i = 0; i < composite.parts.length; i++) {
            const part = composite.parts[i]!;
            const off = offsets[i]!;
            const partPrefab = bucket.get(part.partId) as unknown as Prefab3D;
            const subLods = levelComposites === null
                ? undefined
                : lods!.map((L, k) => ({ prefabId: levelComposites![k]!.parts[i]!.partId, distance: L.distance }));
            const partOpts: MeshInstanceOptions<any> = {
                ...opts,
                prefab: partPrefab,
                lod: subLods,
                position: [basePos[0] + off.px, basePos[1] + off.py, basePos[2] + off.pz],
                rotation: [baseRot[0] + off.rx, baseRot[1] + off.ry, baseRot[2] + off.rz],
            };
            const handle = this.add(partOpts);
            if (handle) childHandles.push(handle);
        }
        if (childHandles.length === 0) {
            throw new Error(`instances.add: composite '${composite.id}' produced no parts`);
        }

        const posOut: [number, number, number] = [basePos[0], basePos[1], basePos[2]];
        const rotOut: [number, number, number] = [baseRot[0], baseRot[1], baseRot[2]];
        const sclOut: [number, number, number] = [1, 1, 1];
        const initialScale = opts.scale;
        if (typeof initialScale === 'number') { sclOut[0] = sclOut[1] = sclOut[2] = initialScale; }
        else if (initialScale) { sclOut[0] = initialScale[0]; sclOut[1] = initialScale[1]; sclOut[2] = initialScale[2]; }

        return {
            id: childHandles[0]!.id,
            slot: childHandles[0]!.slot,
            modelId: childHandles[0]!.modelId,
            get alive() { return childHandles.some((h) => h.alive); },
            skinned: childHandles.some((h) => h.skinned),
            prefabId: composite.id,
            materials: this.makeMaterialsView(childHandles.map((h) => this.materialTarget(h))),
            get textureId() { return childHandles[0]!.textureId; },
            get lodLevel() { return 0; },
            setPosition(x, y, z) {
                posOut[0] = x; posOut[1] = y; posOut[2] = z;
                for (let i = 0; i < childHandles.length; i++) {
                    const o = offsets[i]!;
                    childHandles[i]!.setPosition(x + o.px, y + o.py, z + o.pz);
                }
            },
            setRotation(x, y, z) {
                rotOut[0] = x; rotOut[1] = y; rotOut[2] = z;
                for (let i = 0; i < childHandles.length; i++) {
                    const o = offsets[i]!;
                    childHandles[i]!.setRotation(x + o.rx, y + o.ry, z + o.rz);
                }
            },
            setScale(x, y, z) {
                sclOut[0] = x; sclOut[1] = y; sclOut[2] = z;
                for (const h of childHandles) h.setScale(x, y, z);
            },
            teleport(x, y, z) {
                posOut[0] = x; posOut[1] = y; posOut[2] = z;
                for (let i = 0; i < childHandles.length; i++) {
                    const o = offsets[i]!;
                    childHandles[i]!.teleport(x + o.px, y + o.py, z + o.pz);
                }
            },
            get position() { return posOut as readonly [number, number, number]; },
            get rotation() { return rotOut as readonly [number, number, number]; },
            get scale() { return sclOut as readonly [number, number, number]; },
            setTexture(tex: string | TexturePrefab | null) {
                for (const h of childHandles) h.setTexture?.(tex);
            },
            destroy() {
                for (const h of childHandles) h.destroy();
            },
        };
    }

    private groupHandle(
        childHandles: MeshInstanceHandle[],
        lead: MeshInstanceHandle,
        skinned: boolean,
        prefabId: string | null,
        skinnedHandle: MeshInstanceHandle | undefined,
    ): MeshInstanceHandle {
        return {
            id: lead.id,
            slot: lead.slot,
            modelId: lead.modelId,
            get alive() { return childHandles.some((h) => h.alive); },
            skinned,
            prefabId,
            materials: this.makeMaterialsView(childHandles.map((h) => this.materialTarget(h))),
            get textureId() { return lead.textureId; },
            get lodLevel() { return 0; },
            setPosition(x, y, z) { for (const h of childHandles) h.setPosition(x, y, z); },
            setRotation(x, y, z) { for (const h of childHandles) h.setRotation(x, y, z); },
            setScale(x, y, z) { for (const h of childHandles) h.setScale(x, y, z); },
            teleport(x, y, z) { for (const h of childHandles) h.teleport(x, y, z); },
            get position() { return lead.position; },
            get rotation() { return lead.rotation; },
            get scale() { return lead.scale; },
            play: skinnedHandle?.play ? (name: string, opts?: PlayOptions) => { skinnedHandle.play!(name, opts); } : undefined,
            stop: skinnedHandle?.stop ? () => { skinnedHandle.stop!(); } : undefined,
            setTexture(tex: string | TexturePrefab | null) { for (const h of childHandles) h.setTexture?.(tex); },
            destroy() { for (const h of childHandles) h.destroy(); },
        };
    }
}

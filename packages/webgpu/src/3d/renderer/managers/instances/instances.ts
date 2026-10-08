import { PooledCollection } from 'murow/renderer/collection';
import type { Interpolator } from '../../types';
import type { InstanceId } from '../../ids';
import type { Logger } from 'murow/core';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { Hitbox } from 'murow/core/hitbox';
import type { PlayOptions, Prefab3D, TexturePrefab, PrefabBucket3D, CompositePrefab } from 'murow/renderer';
import { DYNAMIC_MESH_FLOATS, STATIC_MESH_FLOATS, SKINNED_STATIC_MESH_FLOATS } from '../../../../core/types';
import type { GltfModel, MeshInstanceHandle, MeshInstanceOptions, ModelHandle } from '../../types';
import type { ModelLibrary } from '../../internals/model-library';
import type { Frustum } from '../../internals/frustum';
import { InstanceStore } from './instance-store';
import { SkinnedInstanceStore, type SkinModelLike } from './skinned-instance-store';
import { isPrefab3D, resolvePrefabHandle } from './prefab-handle';
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
    /** Upper bound on distinct skin indices; sizes the free-offset table. */
    getSkinModel(index: number): SkinModelLike | undefined;
}

/** A visible non-skinned batch the main pass draws (one model + material). */
export interface MainPassBatch {
    modelId: number;
    materialId: number;
    offset: number;
    count: number;
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
        | { kind: 'static'; opts: MeshInstanceOptions<any>; modelHandle: ModelHandle; prefabId: string | null; materialId: number }
        | { kind: 'skinned'; opts: MeshInstanceOptions<any>; modelHandle: ModelHandle; skinIndex: number; skinModel: SkinModelLike; linkedSlot: number | undefined; prefabId: string | null }
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

    constructor(deps: InstanceManagerDeps) {
        super({ poolSize: deps.poolSize, capacity: deps.capacity, logger: deps.logger });
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
     * @returns the instance handle, or `null` when the pool is full.
     */
    add(opts: MeshInstanceOptions<any>): MeshInstanceHandle | null {
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

        if (prefab?.type === 'composite') {
            return this.addComposite(resolvedOpts, prefab);
        }

        const resolved = prefab ? resolvePrefabHandle(prefab) : resolvedOpts.prefab;

        if ('parts' in (resolved as ModelHandle | GltfModel)) {
            return this.addGltf(resolvedOpts, resolved as GltfModel, userPrefabId);
        }

        const modelHandle = resolved as ModelHandle;
        const model = this.deps.models.get(modelHandle.id);

        if (model?.skinned) {
            return this.spawnSkinned(resolvedOpts, modelHandle, model.skinIndex, undefined, userPrefabId);
        }

        const materialId = resolvedOpts.material ? resolvedOpts.material.slot + 1 : 0;
        return this.spawnStatic(resolvedOpts, modelHandle, userPrefabId, materialId);
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
     * Gather, frustum-cull and pack the visible batches for the main pass. The
     * renderer uploads the resulting slot indices and reads the batch lists.
     * @internal
     */
    prepareFrame(frustum: Frustum): void {
        const store = this.deps.store;
        const skinned = this.deps.skinned;
        const models = this.deps.models;

        let indexOffset = 0;
        let batchCount = 0;
        const dyn = store.dynamicData;
        const stat = store.staticData;
        store.batcher.each((modelId, instances, count, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            const model = models.get(modelId);
            if (!model) return;
            const baseRadius = model.boundingRadius;
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
                if (frustum.intersectsSphere(cx, cy, cz, radius)) {
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
            }
        });
        this.batchCount = batchCount;
        this.slotIndexCount = indexOffset;

        let skinnedIndexOffset = 0;
        let skinnedBatchCount = 0;
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
            }
        });
        this.skinnedBatchCount = skinnedBatchCount;
        this.skinnedSlotIndexCount = skinnedIndexOffset;
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
                    model.halfX, model.halfY, model.halfZ);
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
                    model.halfX, model.halfY, model.halfZ);
            }
        });
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

    protected destroySlot(slot: number): void {
        this.origDestroy[slot]?.();
        this.origDestroy[slot] = null;
        this.rawHandles[slot] = null;
    }

    protected createHandle(id: InstanceId, slot: number): MeshInstanceHandle {
        const p = this.pending!;
        const raw = p.kind === 'skinned'
            ? this.deps.skinned.spawn(p.opts, p.modelHandle, p.skinIndex, p.skinModel, p.linkedSlot, p.prefabId, id)
            : this.deps.store.spawn(p.opts, p.modelHandle, p.prefabId, id, p.materialId);
        return this.installHandle(id, slot, raw);
    }

    private installHandle(id: InstanceId, slot: number, raw: MeshInstanceHandle): MeshInstanceHandle {
        this.rawHandles[slot] = raw;
        const orig = raw.destroy.bind(raw);
        this.origDestroy[slot] = orig;
        Object.defineProperty(raw, 'alive', { configurable: true, get: () => this.has(id) });
        raw.destroy = () => this.remove(id);
        return raw;
    }

    private spawnStatic(
        opts: MeshInstanceOptions<any>,
        modelHandle: ModelHandle,
        prefabId: string | null,
        materialId: number,
    ): MeshInstanceHandle | null {
        this.pending = { kind: 'static', opts, modelHandle, prefabId, materialId };
        const allocated = this.allocateHandle();
        this.pending = null;
        return allocated ? allocated.handle : null;
    }

    private spawnSkinned(
        opts: MeshInstanceOptions<any>,
        modelHandle: ModelHandle,
        skinIndex: number,
        linkedSlot: number | undefined,
        prefabId: string | null,
    ): MeshInstanceHandle | null {
        const skinModel = this.deps.models.skinnedModel(skinIndex);
        if (!skinModel) return null;
        this.pending = {
            kind: 'skinned', opts, modelHandle, skinIndex,
            skinModel: skinModel as unknown as SkinModelLike, linkedSlot, prefabId,
        };
        const allocated = this.allocateHandle();
        this.pending = null;
        return allocated ? allocated.handle : null;
    }

    private addGltf(opts: MeshInstanceOptions<any>, gltf: GltfModel, prefabId: string | null): MeshInstanceHandle {
        const childHandles: MeshInstanceHandle[] = [];
        let firstSkinnedSlot: number | undefined;

        for (const part of gltf.parts) {
            const partOpts = { ...opts, prefab: part };
            const model = this.deps.models.get(part.id);
            if (model?.skinned) {
                const handle = this.spawnSkinned(partOpts, part, model.skinIndex, firstSkinnedSlot, prefabId);
                if (handle) {
                    if (firstSkinnedSlot === undefined) firstSkinnedSlot = handle.slot;
                    childHandles.push(handle);
                }
            } else {
                const handle = this.spawnStatic(partOpts, part, prefabId, 0);
                if (handle) childHandles.push(handle);
            }
        }

        if (childHandles.length === 0) {
            throw new Error(`instances.add: glTF '${gltf.src}' produced no parts`);
        }

        const skinnedHandle = childHandles.find((h) => h.skinned);
        const lead = childHandles[0]!;
        return this.groupHandle(childHandles, lead, gltf.skinned, prefabId, skinnedHandle);
    }

    private addComposite(opts: MeshInstanceOptions<any>, composite: CompositePrefab): MeshInstanceHandle {
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

        const childHandles: MeshInstanceHandle[] = [];
        for (let i = 0; i < composite.parts.length; i++) {
            const part = composite.parts[i]!;
            const off = offsets[i]!;
            const partPrefab = bucket.get(part.partId) as unknown as Prefab3D;
            const partOpts: MeshInstanceOptions<any> = {
                ...opts,
                prefab: partPrefab,
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
            get textureId() { return childHandles[0]!.textureId; },
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
            get textureId() { return lead.textureId; },
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

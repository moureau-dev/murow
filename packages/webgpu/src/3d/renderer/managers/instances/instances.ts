import { PooledCollection } from '../../collection/pooled-collection';
import type { Interpolator } from '../../types';
import type { InstanceId } from '../../collection/ids';
import type { Logger } from 'murow/core';
import type { PlayOptions, Prefab3D, TexturePrefab, PrefabBucket3D, CompositePrefab } from 'murow/renderer';
import type { GltfModel, MeshInstanceHandle, MeshInstanceOptions, ModelHandle } from '../../types';
import type { ModelLibrary } from '../../internals/model-library';
import { InstanceStore } from './instance-store';
import { SkinnedInstanceStore, type SkinModelLike } from './skinned-instance-store';
import { isPrefab3D, resolvePrefabHandle } from './prefab-handle';

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

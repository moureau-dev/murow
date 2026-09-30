import { FreeList } from 'murow/core/free-list';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { TexturePrefab } from 'murow/renderer';
import { DYNAMIC_MESH_FLOATS, STATIC_MESH_FLOATS } from '../../../core/types';
import type { MeshInstanceHandle, MeshInstanceOptions, ModelHandle } from '../types';
import {
    DYN_PREV_PX, DYN_PREV_PY, DYN_PREV_PZ,
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    DYN_PREV_RX, DYN_PREV_RY, DYN_PREV_RZ,
    DYN_CURR_RX, DYN_CURR_RY, DYN_CURR_RZ,
    STAT_SX, STAT_SY, STAT_SZ, STAT_CR, STAT_CG, STAT_CB,
} from './offsets';
import { resolveTransform } from './transform';

export interface InstanceStoreDeps {
    maxInstances: number;
    /** Bind group for a registered texture id, or undefined. */
    getTextureBindGroup(id: string): GPUBindGroup | undefined;
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
    readonly instanceModelIds: Uint8Array;
    readonly instanceHandles: (MeshInstanceHandle | null)[];
    readonly batcher: SparseBatcher;

    staticDirty = false;

    private readonly freeList: FreeList;
    private readonly instanceTextureBGs = new Map<number, GPUBindGroup>();

    constructor(private readonly deps: InstanceStoreDeps) {
        const n = deps.maxInstances;
        this.dynamicData = new Float32Array(n * DYNAMIC_MESH_FLOATS);
        this.staticData = new Float32Array(n * STATIC_MESH_FLOATS);
        this.slotIndexData = new Uint32Array(n);
        this.instanceModelIds = new Uint8Array(n);
        this.instanceHandles = new Array(n).fill(null);
        this.freeList = new FreeList(n);
        this.batcher = new SparseBatcher(n);
    }

    textureBindGroup(instanceId: number): GPUBindGroup | undefined {
        return this.instanceTextureBGs.get(instanceId);
    }

    setTextureBindGroup(instanceId: number, bindGroup: GPUBindGroup): void {
        this.instanceTextureBGs.set(instanceId, bindGroup);
    }

    deleteTextureBindGroup(instanceId: number): void {
        this.instanceTextureBGs.delete(instanceId);
    }

    /** Allocate a slot, write the initial transform, and return a live handle. */
    spawn(opts: MeshInstanceOptions<any>, modelHandle: ModelHandle, userPrefabId: string | null, id: number): MeshInstanceHandle {
        const slot = this.freeList.allocate();
        if (slot === -1) throw new Error(`Max instances (${this.deps.maxInstances}) reached`);

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

        this.staticDirty = true;
        this.instanceModelIds[slot] = modelHandle.id;
        this.batcher.add(0, modelHandle.id, slot);

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
            id,
            slot,
            modelId: modelHandle.id,
            skinned: false,
            prefabId: userPrefabId,
            get textureId() { return currentTexId; },
            setPosition(nx: number, ny: number, nz: number) {
                dyn[dynBase + DYN_CURR_PX] = nx;
                dyn[dynBase + DYN_CURR_PY] = ny;
                dyn[dynBase + DYN_CURR_PZ] = nz;
            },
            setRotation(nx: number, ny: number, nz: number) {
                dyn[dynBase + DYN_CURR_RX] = nx;
                dyn[dynBase + DYN_CURR_RY] = ny;
                dyn[dynBase + DYN_CURR_RZ] = nz;
            },
            setScale(nx: number, ny: number, nz: number) {
                stat[statBase + STAT_SX] = nx;
                stat[statBase + STAT_SY] = ny;
                stat[statBase + STAT_SZ] = nz;
            },
            teleport(nx: number, ny: number, nz: number) {
                dyn[dynBase + DYN_PREV_PX] = nx;
                dyn[dynBase + DYN_PREV_PY] = ny;
                dyn[dynBase + DYN_PREV_PZ] = nz;
                dyn[dynBase + DYN_CURR_PX] = nx;
                dyn[dynBase + DYN_CURR_PY] = ny;
                dyn[dynBase + DYN_CURR_PZ] = nz;
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
                    self.instanceTextureBGs.delete(id);
                    currentTexId = null;
                } else {
                    const texId = typeof tex === 'string' ? tex : tex.id;
                    const bindGroup = self.deps.getTextureBindGroup(texId);
                    if (bindGroup) {
                        self.instanceTextureBGs.set(id, bindGroup);
                        currentTexId = texId;
                    }
                }
            },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                self.instanceTextureBGs.delete(id);
                self.batcher.remove(0, modelHandle.id, slot);
                self.freeList.free(slot);
                dyn.fill(0, dynBase, dynBase + DYNAMIC_MESH_FLOATS);
                stat.fill(0, statBase, statBase + STATIC_MESH_FLOATS);
                self.instanceHandles[slot] = null;
                self.staticDirty = true;
            },
        };
        this.instanceHandles[slot] = handle;

        if (initTexId) {
            const bindGroup = this.deps.getTextureBindGroup(initTexId);
            if (bindGroup) this.instanceTextureBGs.set(id, bindGroup);
        }

        return handle;
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

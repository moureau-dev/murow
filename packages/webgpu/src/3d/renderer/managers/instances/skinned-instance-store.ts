import { SlotMap } from 'murow/core/slot-map';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import type { SkeletalAnimState, PlayOptions, TexturePrefab } from 'murow/renderer';
import { DYNAMIC_MESH_FLOATS, SKINNED_STATIC_MESH_FLOATS } from '../../../../core/types';
import type { MeshInstanceHandle, MeshInstanceOptions, ModelHandle } from '../../types';
import {
    DYN_PREV_PX, DYN_PREV_PY, DYN_PREV_PZ,
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    DYN_PREV_RX, DYN_PREV_RY, DYN_PREV_RZ,
    DYN_CURR_RX, DYN_CURR_RY, DYN_CURR_RZ,
    SSTAT_SX, SSTAT_SY, SSTAT_SZ, SSTAT_CR, SSTAT_CG, SSTAT_CB, SSTAT_BONE_OFFSET, SSTAT_MATERIAL_ID,
} from './offsets';
import { resolveTransform } from './transform';

/** The subset of a loaded skin model the store needs. */
export interface SkinModelLike {
    jointCount: number;
    animation: {
        clipCount: number;
        createState(clipId: number, speed: number, playing: boolean): SkeletalAnimState;
        play(state: SkeletalAnimState, name: string, opts?: PlayOptions): void;
        stop(state: SkeletalAnimState): void;
        computeRestPose(out: Float32Array, offsetFloats: number): void;
    };
}

export interface SkinnedInstanceStoreDeps {
    maxSkinnedInstances: number;
    maxTotalBones: number;
    /** Upper bound on distinct skin indices; sizes the free-offset table. */
    maxSkins: number;
    /** Upload the skin's rest pose into the shared bone-matrix buffer at `boneOffset`. */
    uploadRestPose(skinModel: SkinModelLike, boneOffset: number, jointCount: number): void;
    getTextureBindGroup(id: string): GPUBindGroup | undefined;
    /** Record one instance starting to use a 1-based material id (0 = default). */
    retainMaterial?(materialId: number): void;
    /** Record one instance stopping use of a 1-based material id. */
    releaseMaterial?(materialId: number): void;
}

/**
 * SkinnedInstanceStore — owns the skinned instance pool and its bone-offset
 * pool. Linked multi-part instances share a bone block (refcounted); freed
 * blocks are recycled per skin. The renderer/animation runtime read the dense
 * arrays through this store.
 */
export class SkinnedInstanceStore {
    readonly dynamicData: Float32Array;
    readonly staticData: Float32Array;
    readonly slotIndexData: Uint32Array;
    readonly instanceModelIds: Uint8Array;
    readonly instanceBoneOffsets: Uint32Array;
    readonly instanceHandles: (MeshInstanceHandle | null)[];
    readonly animStates: (SkeletalAnimState | null)[];
    readonly batcher: SparseBatcher;

    staticDirty = false;
    /** Bumped on any transform/structure change; lets consumers cache GPU passes. */
    dynamicVersion = 0;

    /** Per-bone-offset refcount; linked parts share a block. */
    private readonly boneOffsetRefcount: Uint32Array;
    /** Per-bone-offset skinIndex, so freed blocks return to the right pool. */
    private readonly boneOffsetSkinIndex: Uint32Array;
    /** Intrusive free list of bone offsets, one chain per skin (head = offset or -1). */
    private readonly freeHead: Int32Array;
    /** Next free offset in the same skin's chain, or -1. */
    private readonly freeNext: Int32Array;
    private nextBoneOffset = 0;

    private readonly staticDV: DataView;
    /** Dense live-slot set; iterate `activeSlots` over `[0, size)`. */
    readonly slots: SlotMap;
    /** Per-slot texture override bind group, or null for the model default. */
    private readonly textureBGs: (GPUBindGroup | null)[];

    constructor(private readonly deps: SkinnedInstanceStoreDeps) {
        const n = deps.maxSkinnedInstances;
        this.dynamicData = new Float32Array(n * DYNAMIC_MESH_FLOATS);
        this.staticData = new Float32Array(n * SKINNED_STATIC_MESH_FLOATS);
        this.staticDV = new DataView(this.staticData.buffer);
        this.slotIndexData = new Uint32Array(n);
        this.instanceModelIds = new Uint8Array(n);
        this.instanceBoneOffsets = new Uint32Array(n);
        this.animStates = new Array(n).fill(null);
        this.instanceHandles = new Array(n).fill(null);
        this.textureBGs = new Array(n).fill(null);
        this.slots = new SlotMap(n);
        this.batcher = new SparseBatcher(n);

        this.boneOffsetRefcount = new Uint32Array(deps.maxTotalBones);
        this.boneOffsetSkinIndex = new Uint32Array(deps.maxTotalBones);
        this.freeHead = new Int32Array(deps.maxSkins).fill(-1);
        this.freeNext = new Int32Array(deps.maxTotalBones).fill(-1);
    }

    /** Per-slot texture override bind group, or undefined for the model default. */
    textureBindGroup(slot: number): GPUBindGroup | undefined {
        return this.textureBGs[slot] ?? undefined;
    }

    spawn(
        opts: MeshInstanceOptions<any>,
        modelHandle: ModelHandle,
        skinIndex: number,
        skinModel: SkinModelLike,
        linkedSlot: number | undefined,
        prefabId: string | null,
        id: number,
    ): MeshInstanceHandle {
        const slot = this.slots.add();
        if (slot === -1) throw new Error(`Max skinned instances (${this.deps.maxSkinnedInstances}) reached`);

        const jointCount = skinModel.jointCount;
        let boneOffset: number;
        let animState: SkeletalAnimState | null;

        if (linkedSlot !== undefined) {
            boneOffset = this.instanceBoneOffsets[linkedSlot];
            animState = this.animStates[linkedSlot];
            this.boneOffsetRefcount[boneOffset]++;
        } else {
            const head = this.freeHead[skinIndex];
            if (head !== -1) {
                boneOffset = head;
                this.freeHead[skinIndex] = this.freeNext[head];
            } else {
                boneOffset = this.nextBoneOffset + jointCount;
                this.nextBoneOffset += jointCount * 2;
            }
            this.boneOffsetRefcount[boneOffset] = 1;
            this.boneOffsetSkinIndex[boneOffset] = skinIndex;

            this.deps.uploadRestPose(skinModel, boneOffset, jointCount);
            animState = skinModel.animation.clipCount > 0
                ? skinModel.animation.createState(0, 1, true)
                : null;
        }

        this.instanceBoneOffsets[slot] = boneOffset;
        this.animStates[slot] = animState;

        const dynBase = slot * DYNAMIC_MESH_FLOATS;
        const statBase = slot * SKINNED_STATIC_MESH_FLOATS;

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

        stat[statBase + SSTAT_SX] = t.sx;
        stat[statBase + SSTAT_SY] = t.sy;
        stat[statBase + SSTAT_SZ] = t.sz;
        stat[statBase + SSTAT_CR] = t.cr;
        stat[statBase + SSTAT_CG] = t.cg;
        stat[statBase + SSTAT_CB] = t.cb;

        // boneOffset is u32 stored inside the Float32 buffer — reusable DataView.
        this.staticDV.setUint32((statBase + SSTAT_BONE_OFFSET) * 4, boneOffset, true);
        const materialId = opts.material ? opts.material.slot + 1 : 0;
        stat[statBase + SSTAT_MATERIAL_ID] = materialId;
        if (materialId > 0) this.deps.retainMaterial?.(materialId);

        this.staticDirty = true;
        this.dynamicVersion++;
        this.instanceModelIds[slot] = modelHandle.id;
        this.batcher.add(0, modelHandle.id, slot);

        const animStates = this.animStates;
        const animation = skinModel.animation;
        const self = this;
        const capturedBoneOffset = boneOffset;
        const capturedSkinIndex = skinIndex;
        let destroyed = false;

        const posOut: [number, number, number] = [0, 0, 0];
        const rotOut: [number, number, number] = [0, 0, 0];
        const sclOut: [number, number, number] = [0, 0, 0];

        let currentTexId: string | null = null;
        const handle: MeshInstanceHandle = {
            id: id as MeshInstanceHandle['id'],
            get alive() { return !destroyed; },
            slot,
            modelId: modelHandle.id,
            skinned: true,
            prefabId,
            get textureId() { return currentTexId; },
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
                stat[statBase + SSTAT_SX] = nx;
                stat[statBase + SSTAT_SY] = ny;
                stat[statBase + SSTAT_SZ] = nz;
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
                sclOut[0] = stat[statBase + SSTAT_SX];
                sclOut[1] = stat[statBase + SSTAT_SY];
                sclOut[2] = stat[statBase + SSTAT_SZ];
                return sclOut;
            },
            play(name: string, playOpts?: PlayOptions) {
                const state = animStates[slot];
                if (state) animation.play(state, name, playOpts);
            },
            stop() {
                const state = animStates[slot];
                if (state) animation.stop(state);
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
            destroy() {
                if (destroyed) return;
                destroyed = true;
                self.dynamicVersion++;
                const materialId = stat[statBase + SSTAT_MATERIAL_ID]!;
                if (materialId > 0) self.deps.releaseMaterial?.(materialId);
                self.batcher.remove(0, modelHandle.id, slot);
                self.slots.remove(slot);
                dyn.fill(0, dynBase, dynBase + DYNAMIC_MESH_FLOATS);
                stat.fill(0, statBase, statBase + SKINNED_STATIC_MESH_FLOATS);
                self.textureBGs[slot] = null;
                animStates[slot] = null;
                self.instanceHandles[slot] = null;
                self.staticDirty = true;

                if (--self.boneOffsetRefcount[capturedBoneOffset] === 0) {
                    self.freeNext[capturedBoneOffset] = self.freeHead[capturedSkinIndex];
                    self.freeHead[capturedSkinIndex] = capturedBoneOffset;
                }
            },
        };
        this.instanceHandles[slot] = handle;
        return handle;
    }

    /** Reset every skinned instance using `materialId` to the default material (0). */
    reassignMaterial(materialId: number): void {
        if (materialId <= 0) return;
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        const stat = this.staticData;
        for (let i = 0; i < size; i++) {
            const statBase = active[i]! * SKINNED_STATIC_MESH_FLOATS;
            if (stat[statBase + SSTAT_MATERIAL_ID] === materialId) {
                stat[statBase + SSTAT_MATERIAL_ID] = 0;
                this.deps.releaseMaterial?.(materialId);
                this.staticDirty = true;
            }
        }
    }

    /** Copy CURR -> PREV for every live skinned instance. */
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

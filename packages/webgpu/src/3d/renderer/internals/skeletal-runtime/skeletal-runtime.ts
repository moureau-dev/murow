import type { TgpuRoot } from 'typegpu';
import type { PrefabBucket3D, PackedAnimationData, ParsedGltf, SkeletalAnimation } from 'murow/renderer';
import { createPackedAnimationData, packSkinAndAnimations } from 'murow/renderer';
import { DYNAMIC_MESH_FLOATS, SKINNED_STATIC_MESH_FLOATS } from '../../../../core/types';
import type { ComputeKernel } from '../../../../compute/compute-builder';
import type { Camera3D } from '../../../../camera/camera-3d';
import { buildAnimationKernel, uploadPackedToKernel, type AnimationKernelBudgets } from '../../../skeletal-animation-compute/index';
import { packAnimationData } from '../../../skeletal-animation-compute/packer';
import { GltfClipResyncCoordinator } from '../clip-resync-coordinator/clip-resync-coordinator';
import { DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ, SSTAT_SX, SSTAT_SY, SSTAT_SZ } from '../../managers/instances/offsets';
import type { SkinnedInstanceStore } from '../../managers/instances/skinned-instance-store';
import type { MeshPipelines } from '../mesh-pipelines/mesh-pipelines';
import type { SkinCull } from '../skin-cull';

export interface SkinnedModelEntry {
    animation: SkeletalAnimation;
    jointCount: number;
    boundingRadius: number;
    parsedSkin: NonNullable<ParsedGltf['skin']>;
}

export interface SkeletalRuntimeDeps {
    root: TgpuRoot;
    device: GPUDevice;
    pipelines: MeshPipelines;
    skinned: SkinnedInstanceStore;
    camera: Camera3D;
    skinCull: SkinCull;
    maxSkinnedInstances: number;
    maxTotalBones: number;
    /** Upper bound on distinct skin indices, used to size resync tables. */
    maxSkins: number;
    getModel(modelId: number): { skinIndex: number } | undefined;
    getSkinModel(skinIndex: number): SkinnedModelEntry | undefined;
    skinnedModelCount(): number;
}

/**
 * SkeletalRuntime — the GPU skeletal-animation loop: packs clips into the
 * compute kernel, advances per-instance animation clocks, dispatches skinning
 * (or falls back to CPU), and owns the shared CPU bone-matrix buffer.
 */
export class SkeletalRuntime {
    /** CPU bone-matrix staging / rest-pose buffer, shared with the skinned store. */
    readonly boneMatrixData: Float32Array;
    /** Bumped whenever bone matrices are rewritten (some instance is animating). */
    version = 0;

    private packedAnimData: PackedAnimationData = createPackedAnimationData();
    private kernel: ComputeKernel | null = null;
    private needsRebuild = false;
    private budgets: AnimationKernelBudgets | null = null;
    private clipTableOffset = 0;
    private channelTableOffset = 0;
    private jointLookupOffset = 0;
    private readonly gpuInstData: Float32Array;
    private readonly gpuInstDV: DataView;
    private readonly updatedBoneOffsets: Uint8Array;
    private boneMatrixDirty = true;

    private clipResync: GltfClipResyncCoordinator | null = null;

    constructor(private readonly deps: SkeletalRuntimeDeps) {
        this.boneMatrixData = new Float32Array(deps.maxTotalBones * 16);
        this.updatedBoneOffsets = new Uint8Array(deps.maxTotalBones);
        this.gpuInstData = new Float32Array(deps.maxSkinnedInstances * 8);
        this.gpuInstDV = new DataView(this.gpuInstData.buffer);
    }

    /** Create the lazy clip-load coordinator for a prefab bucket. */
    attachBucket(bucket: PrefabBucket3D): void {
        this.clipResync = new GltfClipResyncCoordinator(bucket, this.deps.maxSkins);
    }

    /** Register a skinned glTF prefab's skin index with the resync coordinator. */
    registerSkin(prefabId: string, skinIndex: number): void {
        this.clipResync?.registerSkin(prefabId, skinIndex);
    }

    /** Pack a newly loaded skin's clips and flag a kernel rebuild. */
    addSkin(skinData: Parameters<typeof packSkinAndAnimations>[1], animClips: Parameters<typeof packSkinAndAnimations>[2]): void {
        packSkinAndAnimations(this.packedAnimData, skinData, animClips);
        this.needsRebuild = true;
    }

    /** Notify the runtime that a new skinned model was packed and needs a kernel rebuild. */
    markDirty(): void {
        this.needsRebuild = true;
    }

    /** Write a skin's rest pose into the CPU buffer and upload just that range. */
    writeRestPose(
        skinModel: { jointCount: number; animation: { computeRestPose(out: Float32Array, offsetFloats: number): void } },
        boneOffset: number,
        jointCount: number,
    ): void {
        const restOffsetFloats = boneOffset * 16;
        const restLengthFloats = jointCount * 16;
        skinModel.animation.computeRestPose(this.boneMatrixData, restOffsetFloats);
        this.deps.device.queue.writeBuffer(
            this.deps.pipelines.rawBoneMatrixBuffer,
            restOffsetFloats * 4,
            this.boneMatrixData.buffer,
            this.boneMatrixData.byteOffset + restOffsetFloats * 4,
            restLengthFloats * 4,
        );
    }

    /** Upload the CPU bone buffer if it changed since the last flush. */
    flushBoneMatrices(): void {
        if (!this.boneMatrixDirty) return;
        this.deps.device.queue.writeBuffer(
            this.deps.pipelines.rawBoneMatrixBuffer, 0,
            this.boneMatrixData.buffer, this.boneMatrixData.byteOffset, this.boneMatrixData.byteLength,
        );
        this.boneMatrixDirty = false;
    }

    dispose(): void {
        this.clipResync?.dispose();
        this.clipResync = null;
        this.kernel?.destroy();
        this.kernel = null;
    }

    update(deltaTime: number): void {
        this.syncLazyAnimationChanges();

        if (this.needsRebuild && this.packedAnimData.clips.length > 0) {
            this.kernel?.destroy();
            const budgets = this.growBudgetsForPacked(this.packedAnimData, null);
            const { kernel, packedBuffers } = buildAnimationKernel(
                this.deps.root, this.packedAnimData, this.deps.maxSkinnedInstances, this.deps.maxTotalBones, budgets,
            );
            this.kernel = kernel;
            this.budgets = budgets;
            this.clipTableOffset = packedBuffers.clipTableOffset;
            this.channelTableOffset = packedBuffers.channelTableOffset;
            this.jointLookupOffset = packedBuffers.jointLookupOffset;

            const rawBoneBuffer = this.deps.root.unwrap(kernel.getBuffer('boneMatrices')) as GPUBuffer;
            this.deps.pipelines.setBoneBuffer(rawBoneBuffer);

            this.deps.device.queue.writeBuffer(
                this.deps.pipelines.rawBoneMatrixBuffer, 0,
                this.boneMatrixData.buffer, this.boneMatrixData.byteOffset, this.boneMatrixData.byteLength,
            );
            this.boneMatrixDirty = false;
            this.needsRebuild = false;
        }

        const skinned = this.deps.skinned;
        this.updatedBoneOffsets.fill(0);
        let count = 0;
        const dv = this.gpuInstDV;
        const camPos = this.deps.camera.position;
        const camX = camPos[0], camY = camPos[1], camZ = camPos[2];

        const liveSlots = skinned.slots;
        const activeSlots = liveSlots.activeSlots;
        for (let li = 0; li < liveSlots.size; li++) {
            const slot = activeSlots[li]!;
            const animState = skinned.animStates[slot];
            if (!animState) continue;

            const boneOffset = skinned.instanceBoneOffsets[slot];
            if (this.updatedBoneOffsets[boneOffset]) continue;
            this.updatedBoneOffsets[boneOffset] = 1;

            if (animState.playing) {
                const modelId = skinned.instanceModelIds[slot];
                const model = this.deps.getModel(modelId);
                const skinModel = model && model.skinIndex >= 0 ? this.deps.getSkinModel(model.skinIndex) : null;
                if (skinModel) {
                    animState.time += deltaTime * animState.speed;
                    const clip = skinModel.animation.getClip(animState.clipId);
                    if (clip && clip.duration > 0 && animState.time >= clip.duration) {
                        animState.onEnd();
                        if (animState.loop) {
                            animState.time %= clip.duration;
                        } else {
                            animState.time = clip.duration - 0.0001;
                            animState.playing = false;
                        }
                    }
                }
            }

            if (animState.prevClipId !== -1 && animState.blendDuration > 0) {
                animState.blendWeight += deltaTime / animState.blendDuration;
                if (animState.blendWeight >= 1) {
                    animState.blendWeight = 1;
                    animState.prevClipId = -1;
                    animState.blendDuration = 0;
                }
                animState.prevTime += deltaTime * animState.prevSpeed;
            }

            const modelId = skinned.instanceModelIds[slot];
            const model = this.deps.getModel(modelId);
            const skinIdx = model?.skinIndex ?? 0;

            if (!this.shouldDispatch(slot, model, camX, camY, camZ)) continue;

            const off = count * 32;
            dv.setInt32(off, animState.clipId, true);
            dv.setFloat32(off + 4, animState.time, true);
            dv.setUint32(off + 8, skinIdx, true);
            dv.setUint32(off + 12, boneOffset, true);
            dv.setInt32(off + 16, animState.prevClipId, true);
            dv.setFloat32(off + 20, animState.prevTime, true);
            dv.setFloat32(off + 24, animState.blendWeight, true);
            dv.setFloat32(off + 28, 0, true);
            count++;
        }

        if (count > 0) {
            // Bones changed this frame; consumers (e.g. shadows) can invalidate.
            this.version++;
            if (this.kernel) {
                this.kernel.write('uniforms', {
                    instanceCount: count,
                    clipTableOffset: this.clipTableOffset,
                    channelTableOffset: this.channelTableOffset,
                    jointLookupOffset: this.jointLookupOffset,
                });
                const instBuf = this.kernel.getBuffer('instances');
                const rawInstBuf = this.deps.root.unwrap(instBuf) as GPUBuffer;
                this.deps.device.queue.writeBuffer(rawInstBuf, 0, this.gpuInstData.buffer, 0, count * 32);
                this.kernel.dispatch(count);
            } else {
                this.updatedBoneOffsets.fill(0);
                for (let li = 0; li < liveSlots.size; li++) {
                    const slot = activeSlots[li]!;
                    const animState = skinned.animStates[slot];
                    if (!animState || !animState.playing) continue;
                    const boneOffset = skinned.instanceBoneOffsets[slot];
                    if (this.updatedBoneOffsets[boneOffset]) continue;
                    this.updatedBoneOffsets[boneOffset] = 1;
                    const modelId = skinned.instanceModelIds[slot];
                    const model = this.deps.getModel(modelId);
                    if (!model || model.skinIndex === -1) continue;
                    const skinModel = this.deps.getSkinModel(model.skinIndex);
                    if (!skinModel) continue;
                    skinModel.animation.update(animState, deltaTime, this.boneMatrixData, boneOffset * 16);
                }
                this.deps.device.queue.writeBuffer(
                    this.deps.pipelines.rawBoneMatrixBuffer, 0, this.boneMatrixData as GPUAllowSharedBufferSource,
                );
            }
        }
    }

    private shouldDispatch(
        slot: number,
        model: { skinIndex: number } | undefined,
        camX: number, camY: number, camZ: number,
    ): boolean {
        const skinModel = model && model.skinIndex >= 0 ? this.deps.getSkinModel(model.skinIndex) : undefined;
        const baseRadius = skinModel?.boundingRadius ?? 10;
        const skinned = this.deps.skinned;
        const base = slot * DYNAMIC_MESH_FLOATS;
        const sBase = slot * SKINNED_STATIC_MESH_FLOATS;
        const cx = skinned.dynamicData[base + DYN_CURR_PX];
        const cy = skinned.dynamicData[base + DYN_CURR_PY];
        const cz = skinned.dynamicData[base + DYN_CURR_PZ];
        const sx = Math.abs(skinned.staticData[sBase + SSTAT_SX]);
        const sy = Math.abs(skinned.staticData[sBase + SSTAT_SY]);
        const sz = Math.abs(skinned.staticData[sBase + SSTAT_SZ]);
        const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
        return this.deps.skinCull.shouldUpdate(cx, cy, cz, baseRadius * maxScale, camX, camY, camZ);
    }

    /**
     * Drain pending resyncs from the coordinator. Per affected skin: rebuild
     * its `SkeletalAnimation` clip list densely, remap in-flight animStates,
     * then full-repack `packedAnimData`. Falls back to a kernel rebuild only
     * when the new data exceeds the kernel's allocated budgets.
     */
    private syncLazyAnimationChanges(): void {
        const resync = this.clipResync;
        if (!resync) return;
        const pending = resync.pending;
        if (pending.size === 0) return;

        const skinned = this.deps.skinned;
        const liveSlots = skinned.slots;
        const activeSlots = liveSlots.activeSlots;
        const pendingIds = pending.denseBuffer;

        for (let p = 0; p < pending.size; p++) {
            const skinIndex = pendingIds[p]!;
            const sm = this.deps.getSkinModel(skinIndex);
            if (!sm) continue;
            const remap = sm.animation.replaceClips(sm.parsedSkin.animClips);

            for (let li = 0; li < liveSlots.size; li++) {
                const slot = activeSlots[li]!;
                const animState = skinned.animStates[slot];
                if (!animState) continue;
                const model = this.deps.getModel(skinned.instanceModelIds[slot]);
                if (!model || model.skinIndex !== skinIndex) continue;

                if (animState.clipId >= 0 && animState.clipId < remap.length) {
                    const next = remap[animState.clipId];
                    if (next < 0) {
                        animState.clipId = -1;
                        animState.playing = false;
                    } else {
                        animState.clipId = next;
                    }
                }
                if (animState.prevClipId >= 0 && animState.prevClipId < remap.length) {
                    animState.prevClipId = remap[animState.prevClipId];
                }
            }
        }
        resync.clear();

        this.packedAnimData = createPackedAnimationData();
        const skinCount = this.deps.skinnedModelCount();
        for (let skinIndex = 0; skinIndex < skinCount; skinIndex++) {
            const sm = this.deps.getSkinModel(skinIndex);
            if (!sm) continue;
            packSkinAndAnimations(this.packedAnimData, sm.parsedSkin.data, sm.parsedSkin.animClips);
        }

        if (this.tryUploadInPlace()) return;
        this.needsRebuild = true;
    }

    /** Doubling-growth budgets for kernel storage buffers, with sensible floors. */
    private growBudgetsForPacked(
        packed: PackedAnimationData,
        previous: AnimationKernelBudgets | null,
    ): AnimationKernelBudgets {
        const pb = packAnimationData(packed);
        const grow = (cur: number, prev: number, floor: number) =>
            Math.max(cur * 2, prev, floor);
        return {
            skelI32Capacity:   grow(pb.skelI32.length,   previous?.skelI32Capacity   ?? 0, 256),
            animF32Capacity:   grow(pb.animF32.length,   previous?.animF32Capacity   ?? 0, 4096),
            matricesCapacity:  grow(pb.totalMats,        previous?.matricesCapacity  ?? 0, 8),
        };
    }

    /** Upload `packedAnimData` to the existing kernel iff it fits the current budgets. */
    private tryUploadInPlace(): boolean {
        const kernel = this.kernel;
        const budgets = this.budgets;
        if (!kernel || !budgets) return false;

        const pb = packAnimationData(this.packedAnimData);
        if (pb.skelI32.length  > budgets.skelI32Capacity)  return false;
        if (pb.animF32.length  > budgets.animF32Capacity)  return false;
        if (pb.totalMats       > budgets.matricesCapacity) return false;

        uploadPackedToKernel(this.deps.root, kernel, pb);
        this.clipTableOffset = pb.clipTableOffset;
        this.channelTableOffset = pb.channelTableOffset;
        this.jointLookupOffset = pb.jointLookupOffset;
        return true;
    }
}

/**
 * GPU compute kernel for skeletal animation using ComputeBuilder.
 *
 * TGSL rules followed:
 * - === instead of ==
 * - if/else instead of ternaries for runtime values
 * - No nested function declarations
 * - No closure captures — offsets passed via uniforms
 * - const for non-reassigned values
 * - 6 buffers (under 8 binding limit)
 */
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';
import { ComputeBuilder, type ComputeKernel } from '../../compute/compute-builder';
import { AnimComputeUniforms, InstanceAnimStateGPU } from '../../core/types';
import type { TgpuRoot } from 'typegpu';
import { packAnimationData, type PackedBuffers } from './packer';
import type { PackedAnimationData } from '../gltf-skin-parser';

const WORKGROUP_SIZE = 64;

export function buildAnimationKernel(
    root: TgpuRoot,
    packed: PackedAnimationData,
    maxInstances: number,
    maxTotalBones: number,
): { kernel: ComputeKernel; packedBuffers: PackedBuffers } {
    const pb = packAnimationData(packed);

    const kernel = new ComputeBuilder('skeletal-animation', { workgroupSize: WORKGROUP_SIZE }, root)
        .buffers({
            uniforms:     { uniform: AnimComputeUniforms },
            instances:    { storage: d.arrayOf(InstanceAnimStateGPU, maxInstances) },
            skelI32:      { storage: d.arrayOf(d.i32, pb.skelI32.length) },
            animF32:      { storage: d.arrayOf(d.f32, pb.animF32.length) },
            matrices:     { storage: d.arrayOf(d.mat4x4f, pb.totalMats) },
            boneMatrices: { storage: d.arrayOf(d.mat4x4f, maxTotalBones), readwrite: true },
        })
        .shader(({ uniforms, instances, skelI32, animF32, matrices, boneMatrices }, { globalId }) => {
            const idx = globalId.x;
            // @ts-ignore — TGSL struct field access
            if (idx >= uniforms.instanceCount) { return; }

            const inst = instances[idx];
            if (inst.clipId < 0) { return; }

            // Read skin entry (10 i32 per skin)
            const skinBase = inst.skinIndex * 10;
            const jc = skelI32[skinBase + 0];
            const parentOff = skelI32[skinBase + 1];
            const topoOff: number = skelI32[skinBase + 2];
            const ibmOff = skelI32[skinBase + 3];
            const restOff = skelI32[skinBase + 4];
            const skelRootIdx = skelI32[skinBase + 5];
            const skinClipOffset = skelI32[skinBase + 6];
            const skinLookupOff = skelI32[skinBase + 7];
            const boneOff = d.i32(inst.boneOffset);
            const worldOff = boneOff - jc;

            // Read clip entry
            const globalClipId = inst.clipId + skinClipOffset;
            // @ts-ignore
            const clipBase = globalClipId * 4 + d.i32(uniforms.clipTableOffset);
            const channelStart = skelI32[clipBase + 0];
            const channelCount = skelI32[clipBase + 1];

            const time = inst.time;

            // Process each joint in topological order
            for (let ti = 0; ti < jc; ti = ti + 1) {
                const j = skelI32[topoOff + ti];

                // Read rest pose TRS
                const trsBase = restOff + j * 10;
                let tx = animF32[trsBase + 0]; let ty = animF32[trsBase + 1]; let tz = animF32[trsBase + 2];
                let qx = animF32[trsBase + 3]; let qy = animF32[trsBase + 4]; let qz = animF32[trsBase + 5]; let qw = animF32[trsBase + 6];
                let sx = animF32[trsBase + 7]; let sy = animF32[trsBase + 8]; let sz = animF32[trsBase + 9];

                // Per-joint channel lookup
                const lookupIdx = skinLookupOff + inst.clipId * jc * 2 + j * 2;
                const jChStart = skelI32[lookupIdx];
                const jChCount = skelI32[lookupIdx + 1];

                // Sample animation channels
                for (let ci = 0; ci < jChCount; ci = ci + 1) {
                    // @ts-ignore
                    const chBase = (jChStart + ci) * 4 + d.i32(uniforms.channelTableOffset);
                    const chPathInterp = skelI32[chBase + 1];
                    const chN = skelI32[chBase + 2];
                    const chDataOff = skelI32[chBase + 3];

                    const path = chPathInterp & 3;
                    const isStep = (chPathInterp & 4) !== 0;

                    const t0 = animF32[chDataOff];
                    const tN = animF32[chDataOff + chN - 1];

                    let lo = 0;
                    let hi = chN - 1;

                    if (time <= t0) {
                        lo = 0; hi = 0;
                    } else if (time >= tN) {
                        lo = chN - 1; hi = chN - 1;
                    } else {
                        for (let iter = 0; iter < 20; iter = iter + 1) {
                            if (lo >= hi - 1) { break; }
                            const mid = d.i32((lo + hi) / 2);
                            if (animF32[chDataOff + mid] <= time) { lo = mid; } else { hi = mid; }
                        }
                    }

                    let compCount = 3;
                    if (path === 1) { compCount = 4; }
                    const valBase = chDataOff + chN;

                    if (lo === hi || isStep) {
                        const off = valBase + lo * compCount;
                        if (path === 0) { tx = animF32[off]; ty = animF32[off+1]; tz = animF32[off+2]; }
                        else if (path === 1) { qx = animF32[off]; qy = animF32[off+1]; qz = animF32[off+2]; qw = animF32[off+3]; }
                        else { sx = animF32[off]; sy = animF32[off+1]; sz = animF32[off+2]; }
                    } else {
                        const tLo = animF32[chDataOff + lo];
                        const tHi = animF32[chDataOff + hi];
                        let f = d.f32(0);
                        if (tHi > tLo) { f = (time - tLo) / (tHi - tLo); }
                        const offA = valBase + lo * compCount;
                        const offB = valBase + hi * compCount;

                        if (path === 0) {
                            tx = std.mix(animF32[offA], animF32[offB], f);
                            ty = std.mix(animF32[offA+1], animF32[offB+1], f);
                            tz = std.mix(animF32[offA+2], animF32[offB+2], f);
                        } else if (path === 1) {
                            let ax = animF32[offA]; let ay = animF32[offA+1]; let az = animF32[offA+2]; let aw = animF32[offA+3];
                            let bx = animF32[offB]; let by = animF32[offB+1]; let bz = animF32[offB+2]; let bw = animF32[offB+3];
                            const dot = ax*bx + ay*by + az*bz + aw*bw;
                            if (dot < 0.0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
                            const omf = 1.0 - f;
                            qx = omf*ax + f*bx; qy = omf*ay + f*by; qz = omf*az + f*bz; qw = omf*aw + f*bw;
                            const len = std.sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
                            if (len > 0.0) { const inv = 1.0/len; qx = qx*inv; qy = qy*inv; qz = qz*inv; qw = qw*inv; }
                        } else {
                            sx = std.mix(animF32[offA], animF32[offB], f);
                            sy = std.mix(animF32[offA+1], animF32[offB+1], f);
                            sz = std.mix(animF32[offA+2], animF32[offB+2], f);
                        }
                    }
                }

                // Build local matrix from TRS
                const xx = qx*qx; const yy = qy*qy; const zz = qz*qz;
                const xy = qx*qy; const xz = qx*qz; const yz = qy*qz;
                const wx = qw*qx; const wy = qw*qy; const wz = qw*qz;

                const localMat = d.mat4x4f(
                    (1.0 - 2.0*(yy+zz))*sx, 2.0*(xy+wz)*sx, 2.0*(xz-wy)*sx, 0.0,
                    2.0*(xy-wz)*sy, (1.0 - 2.0*(xx+zz))*sy, 2.0*(yz+wx)*sy, 0.0,
                    2.0*(xz+wy)*sz, 2.0*(yz-wx)*sz, (1.0 - 2.0*(xx+yy))*sz, 0.0,
                    tx, ty, tz, 1.0,
                );

                // Hierarchy walk: world matrix to scratch, bone matrix to output
                const parentJ = skelI32[parentOff + j];
                if (parentJ < 0) {
                    // @ts-ignore — TGSL mat4 * mat4
                    boneMatrices[worldOff + j] = matrices[skelRootIdx] * localMat;
                    // @ts-ignore
                    boneMatrices[boneOff + j] = boneMatrices[worldOff + j] * matrices[ibmOff + j];
                } else {
                    // @ts-ignore
                    boneMatrices[worldOff + j] = boneMatrices[worldOff + parentJ] * localMat;
                    // @ts-ignore
                    boneMatrices[boneOff + j] = boneMatrices[worldOff + j] * matrices[ibmOff + j];
                }
            }

            // --- Crossfade blending ---
            if (inst.prevClipId >= 0 && inst.blendWeight < 1.0) {
                const globalPrevClipId = inst.prevClipId + skinClipOffset;
                // @ts-ignore
                const prevClipBase = globalPrevClipId * 4 + d.i32(uniforms.clipTableOffset);
                const prevTime = inst.prevTime;

                for (let pti = 0; pti < jc; pti = pti + 1) {
                    const pj: number = skelI32[(topoOff as unknown as number) + pti];

                    const ptrsBase = restOff + pj * 10;
                    let ptx = animF32[ptrsBase + 0]; let pty = animF32[ptrsBase + 1]; let ptz = animF32[ptrsBase + 2];
                    let pqx = animF32[ptrsBase + 3]; let pqy = animF32[ptrsBase + 4]; let pqz = animF32[ptrsBase + 5]; let pqw = animF32[ptrsBase + 6];
                    let psx = animF32[ptrsBase + 7]; let psy = animF32[ptrsBase + 8]; let psz = animF32[ptrsBase + 9];

                    const pLookupIdx = skinLookupOff + inst.prevClipId * jc * 2 + (pj as unknown as number) * 2;
                    const pChStart = skelI32[pLookupIdx];
                    const pChCount = skelI32[pLookupIdx + 1];

                    for (let pci = 0; pci < pChCount; pci = pci + 1) {
                        // @ts-ignore
                        const pchBase = (pChStart + pci) * 4 + d.i32(uniforms.channelTableOffset);
                        const pchPathInterp = skelI32[pchBase + 1];
                        const pchN = skelI32[pchBase + 2];
                        const pchDataOff = skelI32[pchBase + 3];
                        const ppath = pchPathInterp & 3;
                        const pisStep = (pchPathInterp & 4) !== 0;

                        const pt0 = animF32[pchDataOff];
                        const ptN = animF32[pchDataOff + pchN - 1];
                        let plo = 0;
                        let phi = pchN - 1;

                        if (prevTime <= pt0) { plo = 0; phi = 0; }
                        else if (prevTime >= ptN) { plo = pchN - 1; phi = pchN - 1; }
                        else {
                            for (let piter = 0; piter < 20; piter = piter + 1) {
                                if (plo >= phi - 1) { break; }
                                const pmid = d.i32((plo + phi) / 2);
                                if (animF32[pchDataOff + pmid] <= prevTime) { plo = pmid; } else { phi = pmid; }
                            }
                        }

                        let pcompCount = 3;
                        if (ppath === 1) { pcompCount = 4; }
                        const pvalBase = pchDataOff + pchN;

                        if (plo === phi || pisStep) {
                            const poff = pvalBase + plo * pcompCount;
                            if (ppath === 0) { ptx = animF32[poff]; pty = animF32[poff+1]; ptz = animF32[poff+2]; }
                            else if (ppath === 1) { pqx = animF32[poff]; pqy = animF32[poff+1]; pqz = animF32[poff+2]; pqw = animF32[poff+3]; }
                            else { psx = animF32[poff]; psy = animF32[poff+1]; psz = animF32[poff+2]; }
                        } else {
                            const ptLo = animF32[pchDataOff + plo];
                            const ptHi = animF32[pchDataOff + phi];
                            let pf = d.f32(0);
                            if (ptHi > ptLo) { pf = (prevTime - ptLo) / (ptHi - ptLo); }
                            const poffA = pvalBase + plo * pcompCount;
                            const poffB = pvalBase + phi * pcompCount;

                            if (ppath === 0) {
                                ptx = std.mix(animF32[poffA], animF32[poffB], pf);
                                pty = std.mix(animF32[poffA+1], animF32[poffB+1], pf);
                                ptz = std.mix(animF32[poffA+2], animF32[poffB+2], pf);
                            } else if (ppath === 1) {
                                let pax = animF32[poffA]; let pay = animF32[poffA+1]; let paz = animF32[poffA+2]; let paw = animF32[poffA+3];
                                let pbx = animF32[poffB]; let pby = animF32[poffB+1]; let pbz = animF32[poffB+2]; let pbw = animF32[poffB+3];
                                const pdot = pax*pbx + pay*pby + paz*pbz + paw*pbw;
                                if (pdot < 0.0) { pbx = -pbx; pby = -pby; pbz = -pbz; pbw = -pbw; }
                                const pomf = 1.0 - pf;
                                pqx = pomf*pax + pf*pbx; pqy = pomf*pay + pf*pby; pqz = pomf*paz + pf*pbz; pqw = pomf*paw + pf*pbw;
                                const plen = std.sqrt(pqx*pqx + pqy*pqy + pqz*pqz + pqw*pqw);
                                if (plen > 0.0) { const pinv = 1.0/plen; pqx = pqx*pinv; pqy = pqy*pinv; pqz = pqz*pinv; pqw = pqw*pinv; }
                            } else {
                                psx = std.mix(animF32[poffA], animF32[poffB], pf);
                                psy = std.mix(animF32[poffA+1], animF32[poffB+1], pf);
                                psz = std.mix(animF32[poffA+2], animF32[poffB+2], pf);
                            }
                        }
                    }

                    // Build prev local matrix
                    const pxx = pqx*pqx; const pyy = pqy*pqy; const pzz = pqz*pqz;
                    const pxy = pqx*pqy; const pxz = pqx*pqz; const pyz = pqy*pqz;
                    const pwx = pqw*pqx; const pwy = pqw*pqy; const pwz = pqw*pqz;

                    const prevLocalMat = d.mat4x4f(
                        (1.0 - 2.0*(pyy+pzz))*psx, 2.0*(pxy+pwz)*psx, 2.0*(pxz-pwy)*psx, 0.0,
                        2.0*(pxy-pwz)*psy, (1.0 - 2.0*(pxx+pzz))*psy, 2.0*(pyz+pwx)*psy, 0.0,
                        2.0*(pxz+pwy)*psz, 2.0*(pyz-pwx)*psz, (1.0 - 2.0*(pxx+pyy))*psz, 0.0,
                        ptx, pty, ptz, 1.0,
                    );

                    // Hierarchy walk for prev clip
                    const prevParentJ = skelI32[parentOff + pj];
                    if (prevParentJ < 0) {
                        // @ts-ignore
                        boneMatrices[worldOff + pj] = matrices[skelRootIdx] * prevLocalMat;
                    } else {
                        // @ts-ignore
                        boneMatrices[worldOff + pj] = boneMatrices[worldOff + prevParentJ] * prevLocalMat;
                    }

                    // Blend: final = lerp(prevBone, currentBone, blendWeight)
                    // @ts-ignore
                    const prevBoneMat: d.Mat4x4f = boneMatrices[worldOff + pj] * matrices[ibmOff + pj];
                    const curBoneMat: d.Mat4x4f = boneMatrices[boneOff + pj];
                    const w = inst.blendWeight;
                    const omw = 1.0 - w;
                    boneMatrices[boneOff + pj] = d.mat4x4f(
                        // @ts-ignore
                        curBoneMat.columns[0] * w + prevBoneMat.columns[0] * omw,
                        // @ts-ignore
                        curBoneMat.columns[1] * w + prevBoneMat.columns[1] * omw,
                        // @ts-ignore
                        curBoneMat.columns[2] * w + prevBoneMat.columns[2] * omw,
                        // @ts-ignore
                        curBoneMat.columns[3] * w + prevBoneMat.columns[3] * omw,
                    );
                }
            }
        })
        .build();

    // Upload static data
    kernel.write('skelI32', Array.from(pb.skelI32));
    kernel.write('animF32', Array.from(pb.animF32));

    // Upload matrices via raw buffer (TypeGPU mat4x4f write format is complex)
    const matBuffer = kernel.getBuffer('matrices');
    const rawMatBuffer = root.unwrap(matBuffer) as GPUBuffer;
    root.device.queue.writeBuffer(rawMatBuffer, 0, pb.matFloats as GPUAllowSharedBufferSource);

    return { kernel, packedBuffers: pb };
}

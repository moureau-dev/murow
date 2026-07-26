/**
 * GPU compute kernel for skeletal animation using ComputeBuilder.
 *
 * TGSL rules followed:
 * - === instead of ==
 * - if/else instead of ternaries for runtime values
 * - No nested function declarations
 * - No closure captures — offsets passed via uniforms
 * - 6 buffers (under 8 binding limit)
 */
// Use bundler-safe wraps so `d.X` / `std.X` accesses inside the shader
// function body survive Rollup's namespace-member inlining (see
// ../../shaders/typegpu.ts).
import type * as _d from 'typegpu/data';
import { d, std } from '../../shaders/typegpu';
import { ComputeBuilder, type ComputeKernel } from '../../compute/compute-builder';
import { AnimComputeUniforms, InstanceAnimStateGPU } from '../../core/types';
import type { TgpuRoot } from 'typegpu';
import { packAnimationData, type PackedBuffers } from './packer';
import type { PackedAnimationData } from 'murow/renderer';

const WORKGROUP_SIZE = 64;

/**
 * Capacity headroom for each storage buffer. Over-allocating is harmless —
 * the kernel only ever reads as far as the uploaded data describes — and
 * lets resyncs upload via `writeBuffer` instead of rebuilding the kernel.
 */
export interface AnimationKernelBudgets {
    skelI32Capacity: number;
    animF32Capacity: number;
    matricesCapacity: number;
}

export function buildAnimationKernel(
    root: TgpuRoot,
    packed: PackedAnimationData,
    maxInstances: number,
    maxTotalBones: number,
    budgets: AnimationKernelBudgets,
): { kernel: ComputeKernel; packedBuffers: PackedBuffers; budgets: AnimationKernelBudgets } {
    const pb = packAnimationData(packed);

    // Packed data layout (see packer.ts):
    //   skelI32: 10 i32 per skin entry
    //   animF32: 10 f32 per joint (tx,ty,tz, qx,qy,qz,qw, sx,sy,sz)
    //   lookup:   2 i32 per joint per clip
    //   channel:  4 i32 per animation channel entry
    const kernel = new ComputeBuilder('skeletal-animation', { workgroupSize: WORKGROUP_SIZE }, root)
        .buffers({
            uniforms:     { uniform: AnimComputeUniforms },
            instances:    { storage: d.arrayOf(InstanceAnimStateGPU, maxInstances) },
            skelI32:      { storage: d.arrayOf(d.i32, budgets.skelI32Capacity) },
            animF32:      { storage: d.arrayOf(d.f32, budgets.animF32Capacity) },
            // mat4x4f arrays — TypeGPU's built-in mat4 * mat4 operator gives
            // correct matrix multiplication (tested in the original working code).
            matrices:     { storage: d.arrayOf(d.mat4x4f, budgets.matricesCapacity) },
            boneMatrices: { storage: d.arrayOf(d.mat4x4f, maxTotalBones), readwrite: true },
        })
        .shader(({ uniforms, instances, skelI32, animF32, matrices, boneMatrices }, { globalId }) => {
            'use gpu';
            const idx = globalId.x;
            // @ts-ignore — TGSL struct field access
            if (idx >= uniforms.instanceCount) { return; }

            const inst = instances[idx];
            if (inst.clipId < 0) { return; }

            // Read skin entry
            const skinBase = inst.skinIndex * 10;
            const jointCount = skelI32[skinBase + 0];
            const parentDataOff = skelI32[skinBase + 1];
            const topoDataOff: number = skelI32[skinBase + 2];
            const ibmOff = skelI32[skinBase + 3];
            const restOff = skelI32[skinBase + 4];
            const skelRootIdx = skelI32[skinBase + 5];
            const skinLookupOff = skelI32[skinBase + 7];
            const boneOff = d.i32(inst.boneOffset);
            const worldOff = boneOff - jointCount;

            const time = inst.time;

            // Process each joint in topological order
            for (let ti = 0; ti < jointCount; ti = ti + 1) {
                const j = skelI32[topoDataOff + ti];

                // Read rest pose TRS
                const trsBase = restOff + j * 10;
                let tx = animF32[trsBase + 0]; let ty = animF32[trsBase + 1]; let tz = animF32[trsBase + 2];
                let qx = animF32[trsBase + 3]; let qy = animF32[trsBase + 4]; let qz = animF32[trsBase + 5]; let qw = animF32[trsBase + 6];
                let sx = animF32[trsBase + 7]; let sy = animF32[trsBase + 8]; let sz = animF32[trsBase + 9];

                // Per-joint channel lookup (2 i32 per joint per clip: start, count)
                const lookupIdx = skinLookupOff + inst.clipId * jointCount * 2 + j * 2;
                const channelStart = skelI32[lookupIdx];
                const channelCount = skelI32[lookupIdx + 1];

                // Sample animation channels
                for (let ci = 0; ci < channelCount; ci = ci + 1) {
                    // @ts-ignore
                    const chBase = (channelStart + ci) * 4 + d.i32(uniforms.channelTableOffset);
                    const chPathInterp = skelI32[chBase + 1];
                    const chKeyCount = skelI32[chBase + 2];
                    const chDataOff = skelI32[chBase + 3];

                    const path = chPathInterp & 3;
                    const isStep = (chPathInterp & 4) !== 0;

                    const t0 = animF32[chDataOff];
                    const tN = animF32[chDataOff + chKeyCount - 1];

                    let lo = d.i32(idx - idx);   // runtime expression prevents TypeGPU const-folding
                    let hi = chKeyCount - 1;

                    if (time <= t0) {
                        lo = d.i32(0); hi = d.i32(0);
                    } else if (time >= tN) {
                        lo = d.i32(chKeyCount - 1); hi = d.i32(chKeyCount - 1);
                    } else {
                        for (let iter = 0; iter < 20; iter = iter + 1) {
                            if (lo >= hi - 1) { break; }
                            const mid = d.i32((lo + hi) / 2);
                            if (animF32[chDataOff + mid] <= time) { lo = mid; } else { hi = mid; }
                        }
                    }

                    let compCount = d.i32(time - time) + 3;
                    if (path === 1) { compCount = d.i32(4); }
                    const valBase = chDataOff + chKeyCount;

                    if (lo === hi || isStep) {
                        const off = valBase + lo * compCount;
                        if (path === 0) { tx = animF32[off]; ty = animF32[off+1]; tz = animF32[off+2]; }
                        else if (path === 1) { qx = animF32[off]; qy = animF32[off+1]; qz = animF32[off+2]; qw = animF32[off+3]; }
                        else { sx = animF32[off]; sy = animF32[off+1]; sz = animF32[off+2]; }
                    } else {
                        const tLo = animF32[chDataOff + lo];
                        const tHi = animF32[chDataOff + hi];
                        let f = d.f32(time - time);
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

                // Build local matrix from TRS (quaternion → rotation matrix)
                const xx = qx*qx; const yy = qy*qy; const zz = qz*qz;
                const xy = qx*qy; const xz = qx*qz; const yz = qy*qz;
                const wx = qw*qx; const wy = qw*qy; const wz = qw*qz;

                // @ts-ignore — TGSL: d.mat4x4f(16 x f32)
                const localMat = d.mat4x4f(
                    (1.0 - 2.0*(yy+zz))*sx, 2.0*(xy+wz)*sx, 2.0*(xz-wy)*sx, d.f32(0),
                    2.0*(xy-wz)*sy, (1.0 - 2.0*(xx+zz))*sy, 2.0*(yz+wx)*sy, d.f32(0),
                    2.0*(xz+wy)*sz, 2.0*(yz-wx)*sz, (1.0 - 2.0*(xx+yy))*sz, d.f32(0),
                    tx, ty, tz, d.f32(1),
                );

                // Hierarchy walk: world → worldOff, final (IBM-applied) → boneOff
                const parentJ = skelI32[parentDataOff + j];
                if (parentJ < 0) {
                    // Root: world = srm * local, final = world * ibm
                    // @ts-ignore — TGSL mat4 * mat4
                    boneMatrices[(worldOff + j)] = matrices[skelRootIdx] * localMat;
                    // @ts-ignore
                    boneMatrices[(boneOff + j)] = boneMatrices[(worldOff + j)] * matrices[(ibmOff + j)];
                } else {
                    // Non-root: world = parentWorld * local, final = world * ibm
                    // @ts-ignore
                    boneMatrices[(worldOff + j)] = boneMatrices[(worldOff + parentJ)] * localMat;
                    // @ts-ignore
                    boneMatrices[(boneOff + j)] = boneMatrices[(worldOff + j)] * matrices[(ibmOff + j)];
                }
            }

            // --- Crossfade blending ---
            if (inst.prevClipId >= 0 && inst.blendWeight < 1.0) {
                const prevTime = inst.prevTime;

                for (let pti = 0; pti < jointCount; pti = pti + 1) {
                    const pj = skelI32[topoDataOff + pti];

                    const ptrsBase = restOff + pj * 10;
                    let ptx = animF32[ptrsBase + 0]; let pty = animF32[ptrsBase + 1]; let ptz = animF32[ptrsBase + 2];
                    let pqx = animF32[ptrsBase + 3]; let pqy = animF32[ptrsBase + 4]; let pqz = animF32[ptrsBase + 5]; let pqw = animF32[ptrsBase + 6];
                    let psx = animF32[ptrsBase + 7]; let psy = animF32[ptrsBase + 8]; let psz = animF32[ptrsBase + 9];

                    const pLookupIdx = skinLookupOff + inst.prevClipId * jointCount * 2 + pj * 2;
                    const prevChStart = skelI32[pLookupIdx];
                    const prevChCount = skelI32[pLookupIdx + 1];

                    for (let pci = 0; pci < prevChCount; pci = pci + 1) {
                        // @ts-ignore
                        const pchBase = (prevChStart + pci) * 4 + d.i32(uniforms.channelTableOffset);
                        const pchPathInterp = skelI32[pchBase + 1];
                        const pchKeyCount = skelI32[pchBase + 2];
                        const pchDataOff = skelI32[pchBase + 3];
                        const ppath = pchPathInterp & 3;
                        const pisStep = (pchPathInterp & 4) !== 0;

                        const pt0 = animF32[pchDataOff];
                        const ptN = animF32[pchDataOff + pchKeyCount - 1];
                        let prevLo = d.i32(time - time);
                        let prevHi = pchKeyCount - 1;

                        if (prevTime <= pt0) { prevLo = d.i32(0); prevHi = d.i32(0); }
                        else if (prevTime >= ptN) { prevLo = d.i32(pchKeyCount - 1); prevHi = d.i32(pchKeyCount - 1); }
                        else {
                            for (let piter = 0; piter < 20; piter = piter + 1) {
                                if (prevLo >= prevHi - 1) { break; }
                                const pmid = d.i32((prevLo + prevHi) / 2);
                                if (animF32[pchDataOff + pmid] <= prevTime) { prevLo = pmid; } else { prevHi = pmid; }
                            }
                        }

                        let prevCompCount = d.i32(time - time) + 3;
                        if (ppath === 1) { prevCompCount = d.i32(4); }
                        const pvalBase = pchDataOff + pchKeyCount;

                        if (prevLo === prevHi || pisStep) {
                            const poff = pvalBase + prevLo * prevCompCount;
                            if (ppath === 0) { ptx = animF32[poff]; pty = animF32[poff+1]; ptz = animF32[poff+2]; }
                            else if (ppath === 1) { pqx = animF32[poff]; pqy = animF32[poff+1]; pqz = animF32[poff+2]; pqw = animF32[poff+3]; }
                            else { psx = animF32[poff]; psy = animF32[poff+1]; psz = animF32[poff+2]; }
                        } else {
                            const ptLo = animF32[pchDataOff + prevLo];
                            const ptHi = animF32[pchDataOff + prevHi];
                            let pf = d.f32(time - time);
                            if (ptHi > ptLo) { pf = (prevTime - ptLo) / (ptHi - ptLo); }
                            const poffA = pvalBase + prevLo * prevCompCount;
                            const poffB = pvalBase + prevHi * prevCompCount;

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

                    // @ts-ignore
                    const prevLocalMat = d.mat4x4f(
                        (1.0 - 2.0*(pyy+pzz))*psx, 2.0*(pxy+pwz)*psx, 2.0*(pxz-pwy)*psx, d.f32(0),
                        2.0*(pxy-pwz)*psy, (1.0 - 2.0*(pxx+pzz))*psy, 2.0*(pyz+pwx)*psy, d.f32(0),
                        2.0*(pxz+pwy)*psz, 2.0*(pyz-pwx)*psz, (1.0 - 2.0*(pxx+pyy))*psz, d.f32(0),
                        ptx, pty, ptz, d.f32(1),
                    );

                    // Hierarchy walk for prev clip
                    const prevParentJ = skelI32[parentDataOff + pj];
                    if (prevParentJ < 0) {
                        // @ts-ignore
                        boneMatrices[(worldOff + pj)] = matrices[skelRootIdx] * prevLocalMat;
                    } else {
                        // @ts-ignore
                        boneMatrices[(worldOff + pj)] = boneMatrices[(worldOff + prevParentJ)] * prevLocalMat;
                    }

                    // Blend: final = lerp(prevBone, currentBone, blendWeight)
                    // Assign to variables first so .columns resolve correctly.
                    // @ts-ignore
                    const prevBoneMat: _d.Mat4x4f = boneMatrices[(worldOff + pj)] * matrices[(ibmOff + pj)];
                    // @ts-ignore
                    const curBoneMat: _d.Mat4x4f = boneMatrices[(boneOff + pj)];
                    const blendWeight = inst.blendWeight;
                    const oneMinusBlend = d.f32(1) - blendWeight;
                    boneMatrices[(boneOff + pj)] = d.mat4x4f(
                        // @ts-ignore — TGSL runtime: columns[col] returns vec4f
                        curBoneMat.columns[0] * blendWeight + prevBoneMat.columns[0] * oneMinusBlend,
                        // @ts-ignore
                        curBoneMat.columns[1] * blendWeight + prevBoneMat.columns[1] * oneMinusBlend,
                        // @ts-ignore
                        curBoneMat.columns[2] * blendWeight + prevBoneMat.columns[2] * oneMinusBlend,
                        // @ts-ignore
                        curBoneMat.columns[3] * blendWeight + prevBoneMat.columns[3] * oneMinusBlend,
                    );
                }
            }
        }).build();

    uploadPackedToKernel(root, kernel, pb);

    return { kernel, packedBuffers: pb, budgets };
}

export function uploadPackedToKernel(root: TgpuRoot, kernel: ComputeKernel, pb: PackedBuffers): void {
    const queue = root.device.queue;

    const skelBuf = root.unwrap(kernel.getBuffer('skelI32')) as GPUBuffer;
    queue.writeBuffer(skelBuf, 0, pb.skelI32 as GPUAllowSharedBufferSource);

    const animBuf = root.unwrap(kernel.getBuffer('animF32')) as GPUBuffer;
    queue.writeBuffer(animBuf, 0, pb.animF32 as GPUAllowSharedBufferSource);

    const matBuf = root.unwrap(kernel.getBuffer('matrices')) as GPUBuffer;
    queue.writeBuffer(matBuf, 0, pb.matFloats as GPUAllowSharedBufferSource);
}

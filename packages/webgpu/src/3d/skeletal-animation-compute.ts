/**
 * GPU compute-based skeletal animation using raw WGSL.
 *
 * Packs all animation data into flat buffers and dispatches a compute shader
 * that evaluates bone matrices entirely on the GPU.
 *
 * Uses raw WebGPU pipeline (not ComputeBuilder) because the shader complexity
 * exceeds what the TGSL transpiler can handle (mixed int/float arithmetic,
 * binary search, quaternion math, matrix hierarchy walk).
 */
import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import * as d from 'typegpu/data';
import type { PackedAnimationData } from './gltf-skin-parser';

const WORKGROUP_SIZE = 64;

const WGSL_SHADER = /* wgsl */`
struct AnimUniforms {
    instanceCount: u32,
    clipTableOffset: u32,
    channelTableOffset: u32,
    jointLookupOffset: u32,
}

struct InstanceState {
    clipId: i32,
    time: f32,
    skinIndex: u32,
    boneOffset: u32,
    prevClipId: i32,
    prevTime: f32,
    blendWeight: f32,
    _pad: f32,
}

@group(0) @binding(0) var<uniform> uniforms: AnimUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceState>;
@group(0) @binding(2) var<storage, read> skelI32: array<i32>;
@group(0) @binding(3) var<storage, read> animF32: array<f32>;
@group(0) @binding(4) var<storage, read> matrices: array<mat4x4f>;
@group(0) @binding(5) var<storage, read_write> boneMatrices: array<mat4x4f>;

fn trsToMat4(tx: f32, ty: f32, tz: f32, qx: f32, qy: f32, qz: f32, qw: f32, sx: f32, sy: f32, sz: f32) -> mat4x4f {
    let xx = qx*qx; let yy = qy*qy; let zz = qz*qz;
    let xy = qx*qy; let xz = qx*qz; let yz = qy*qz;
    let wx = qw*qx; let wy = qw*qy; let wz = qw*qz;
    return mat4x4f(
        (1.0 - 2.0*(yy+zz))*sx, 2.0*(xy+wz)*sx, 2.0*(xz-wy)*sx, 0.0,
        2.0*(xy-wz)*sy, (1.0 - 2.0*(xx+zz))*sy, 2.0*(yz+wx)*sy, 0.0,
        2.0*(xz+wy)*sz, 2.0*(yz-wx)*sz, (1.0 - 2.0*(xx+yy))*sz, 0.0,
        tx, ty, tz, 1.0,
    );
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= uniforms.instanceCount) { return; }

    let inst = instances[idx];
    if (inst.clipId < 0) { return; }

    // Read skin entry (10 i32 per skin)
    let skinBase = i32(inst.skinIndex) * 10;
    let jc = u32(skelI32[skinBase + 0]);
    let parentOff = skelI32[skinBase + 1];
    let topoOff = skelI32[skinBase + 2];
    let ibmOff = skelI32[skinBase + 3];
    let restOff = skelI32[skinBase + 4];
    let skelRootIdx = u32(skelI32[skinBase + 5]);
    let skinClipOffset = skelI32[skinBase + 6];  // global clip index offset for this skin
    let skinLookupOff = skelI32[skinBase + 7];   // absolute joint lookup offset in skelI32
    let boneOff = inst.boneOffset;      // points to final bone matrices (second half)
    let worldOff = boneOff - jc;       // world matrices stored before the final section

    // Read clip entry (clipId is local to skin, add skinClipOffset for global)
    let globalClipId = inst.clipId + skinClipOffset;
    let clipBase = globalClipId * 4 + i32(uniforms.clipTableOffset);
    let channelStart = skelI32[clipBase + 0];
    let channelCount = skelI32[clipBase + 1];

    let time = inst.time;

    // Process each joint in topological order (rest pose only — no animation sampling)
    for (var ti: u32 = 0u; ti < jc; ti++) {
        let j = skelI32[topoOff + i32(ti)];

        // Read rest pose TRS
        let trsBase = restOff + j * 10;
        var tx = animF32[trsBase + 0]; var ty = animF32[trsBase + 1]; var tz = animF32[trsBase + 2];
        var qx = animF32[trsBase + 3]; var qy = animF32[trsBase + 4]; var qz = animF32[trsBase + 5]; var qw = animF32[trsBase + 6];
        var sx = animF32[trsBase + 7]; var sy = animF32[trsBase + 8]; var sz = animF32[trsBase + 9];

        // Sample animation channels — use per-joint lookup for O(1) access
        // Lookup is per (local clipId, joint): skinLookupOff + localClipId * jc * 2 + j * 2
        let lookupIdx = skinLookupOff + inst.clipId * i32(jc) * 2 + j * 2;
        let jChStart = skelI32[lookupIdx];
        let jChCount = skelI32[lookupIdx + 1];

        for (var ci: i32 = 0; ci < jChCount; ci++) {
            let chBase = (jChStart + ci) * 4 + i32(uniforms.channelTableOffset);

            let chPathInterp = u32(skelI32[chBase + 1]);
            let chN = skelI32[chBase + 2];
            let chDataOff = skelI32[chBase + 3];

            let path = chPathInterp & 3u;
            let isStep = (chPathInterp & 4u) != 0u;

            let t0 = animF32[chDataOff];
            let tN = animF32[chDataOff + chN - 1];

            var lo: i32 = 0;
            var hi: i32 = chN - 1;

            if (time <= t0) {
                lo = 0; hi = 0;
            } else if (time >= tN) {
                lo = chN - 1; hi = chN - 1;
            } else {
                for (var iter: i32 = 0; iter < 20; iter++) {
                    if (lo >= hi - 1) { break; }
                    let mid = (lo + hi) / 2;
                    if (animF32[chDataOff + mid] <= time) { lo = mid; } else { hi = mid; }
                }
            }

            var compCount: i32 = 3;
            if (path == 1u) { compCount = 4; }
            let valBase = chDataOff + chN;

            if (lo == hi || isStep) {
                let off = valBase + lo * compCount;
                if (path == 0u) { tx = animF32[off]; ty = animF32[off+1]; tz = animF32[off+2]; }
                else if (path == 1u) { qx = animF32[off]; qy = animF32[off+1]; qz = animF32[off+2]; qw = animF32[off+3]; }
                else { sx = animF32[off]; sy = animF32[off+1]; sz = animF32[off+2]; }
            } else {
                let tLo = animF32[chDataOff + lo];
                let tHi = animF32[chDataOff + hi];
                var f: f32 = 0.0;
                if (tHi > tLo) { f = (time - tLo) / (tHi - tLo); }
                let offA = valBase + lo * compCount;
                let offB = valBase + hi * compCount;

                if (path == 0u) {
                    tx = mix(animF32[offA], animF32[offB], f);
                    ty = mix(animF32[offA+1], animF32[offB+1], f);
                    tz = mix(animF32[offA+2], animF32[offB+2], f);
                } else if (path == 1u) {
                    // Quaternion nlerp
                    var ax = animF32[offA]; var ay = animF32[offA+1]; var az = animF32[offA+2]; var aw = animF32[offA+3];
                    var bx = animF32[offB]; var by = animF32[offB+1]; var bz = animF32[offB+2]; var bw = animF32[offB+3];
                    let dot = ax*bx + ay*by + az*bz + aw*bw;
                    if (dot < 0.0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
                    let omf = 1.0 - f;
                    qx = omf*ax + f*bx; qy = omf*ay + f*by; qz = omf*az + f*bz; qw = omf*aw + f*bw;
                    let len = sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
                    if (len > 0.0) { let inv = 1.0/len; qx *= inv; qy *= inv; qz *= inv; qw *= inv; }
                } else {
                    sx = mix(animF32[offA], animF32[offB], f);
                    sy = mix(animF32[offA+1], animF32[offB+1], f);
                    sz = mix(animF32[offA+2], animF32[offB+2], f);
                }
            }
        }

        // Build local matrix from TRS
        let localMat = trsToMat4(tx, ty, tz, qx, qy, qz, qw, sx, sy, sz);

        // Single pass: write world matrix to scratch section, final bone to output section
        let parentJ = skelI32[parentOff + j];
        var worldMat: mat4x4f;
        if (parentJ < 0) {
            worldMat = matrices[skelRootIdx] * localMat;
        } else {
            worldMat = boneMatrices[worldOff + u32(parentJ)] * localMat;
        }

        // World matrix — children read from here
        boneMatrices[worldOff + u32(j)] = worldMat;
        // Final bone matrix — vertex shader reads from here
        boneMatrices[boneOff + u32(j)] = worldMat * matrices[u32(ibmOff) + u32(j)];
    }

    // --- Crossfade blending ---
    if (inst.prevClipId >= 0 && inst.blendWeight < 1.0) {
        // Read previous clip entry
        let globalPrevClipId = inst.prevClipId + skinClipOffset;
        let prevClipBase = globalPrevClipId * 4 + i32(uniforms.clipTableOffset);
        let prevChannelStart = skelI32[prevClipBase + 0];
        let prevChannelCount = skelI32[prevClipBase + 1];
        let prevTime = inst.prevTime;

        // Evaluate previous clip into worldOff section (reuse as scratch)
        for (var pti: u32 = 0u; pti < jc; pti++) {
            let pj = skelI32[topoOff + i32(pti)];

            // Read rest pose TRS
            let ptrsBase = restOff + pj * 10;
            var ptx = animF32[ptrsBase + 0]; var pty = animF32[ptrsBase + 1]; var ptz = animF32[ptrsBase + 2];
            var pqx = animF32[ptrsBase + 3]; var pqy = animF32[ptrsBase + 4]; var pqz = animF32[ptrsBase + 5]; var pqw = animF32[ptrsBase + 6];
            var psx = animF32[ptrsBase + 7]; var psy = animF32[ptrsBase + 8]; var psz = animF32[ptrsBase + 9];

            // Sample previous clip channels using per-joint lookup
            let pLookupIdx = skinLookupOff + inst.prevClipId * i32(jc) * 2 + pj * 2;
            let pChStart = skelI32[pLookupIdx];
            let pChCount = skelI32[pLookupIdx + 1];

            for (var pci: i32 = 0; pci < pChCount; pci++) {
                let pchBase = (pChStart + pci) * 4 + i32(uniforms.channelTableOffset);
                let pchPathInterp = u32(skelI32[pchBase + 1]);
                let pchN = skelI32[pchBase + 2];
                let pchDataOff = skelI32[pchBase + 3];
                let ppath = pchPathInterp & 3u;
                let pisStep = (pchPathInterp & 4u) != 0u;

                let pt0 = animF32[pchDataOff];
                let ptN = animF32[pchDataOff + pchN - 1];
                var plo: i32 = 0;
                var phi: i32 = pchN - 1;

                if (prevTime <= pt0) { plo = 0; phi = 0; }
                else if (prevTime >= ptN) { plo = pchN - 1; phi = pchN - 1; }
                else {
                    for (var piter: i32 = 0; piter < 20; piter++) {
                        if (plo >= phi - 1) { break; }
                        let pmid = (plo + phi) / 2;
                        if (animF32[pchDataOff + pmid] <= prevTime) { plo = pmid; } else { phi = pmid; }
                    }
                }

                var pcompCount: i32 = 3;
                if (ppath == 1u) { pcompCount = 4; }
                let pvalBase = pchDataOff + pchN;

                if (plo == phi || pisStep) {
                    let poff = pvalBase + plo * pcompCount;
                    if (ppath == 0u) { ptx = animF32[poff]; pty = animF32[poff+1]; ptz = animF32[poff+2]; }
                    else if (ppath == 1u) { pqx = animF32[poff]; pqy = animF32[poff+1]; pqz = animF32[poff+2]; pqw = animF32[poff+3]; }
                    else { psx = animF32[poff]; psy = animF32[poff+1]; psz = animF32[poff+2]; }
                } else {
                    let ptLo = animF32[pchDataOff + plo];
                    let ptHi = animF32[pchDataOff + phi];
                    var pf: f32 = 0.0;
                    if (ptHi > ptLo) { pf = (prevTime - ptLo) / (ptHi - ptLo); }
                    let poffA = pvalBase + plo * pcompCount;
                    let poffB = pvalBase + phi * pcompCount;

                    if (ppath == 0u) {
                        ptx = mix(animF32[poffA], animF32[poffB], pf);
                        pty = mix(animF32[poffA+1], animF32[poffB+1], pf);
                        ptz = mix(animF32[poffA+2], animF32[poffB+2], pf);
                    } else if (ppath == 1u) {
                        var pax = animF32[poffA]; var pay = animF32[poffA+1]; var paz = animF32[poffA+2]; var paw = animF32[poffA+3];
                        var pbx = animF32[poffB]; var pby = animF32[poffB+1]; var pbz = animF32[poffB+2]; var pbw = animF32[poffB+3];
                        let pdot = pax*pbx + pay*pby + paz*pbz + paw*pbw;
                        if (pdot < 0.0) { pbx = -pbx; pby = -pby; pbz = -pbz; pbw = -pbw; }
                        let pomf = 1.0 - pf;
                        pqx = pomf*pax + pf*pbx; pqy = pomf*pay + pf*pby; pqz = pomf*paz + pf*pbz; pqw = pomf*paw + pf*pbw;
                        let plen = sqrt(pqx*pqx + pqy*pqy + pqz*pqz + pqw*pqw);
                        if (plen > 0.0) { let pinv = 1.0/plen; pqx *= pinv; pqy *= pinv; pqz *= pinv; pqw *= pinv; }
                    } else {
                        psx = mix(animF32[poffA], animF32[poffB], pf);
                        psy = mix(animF32[poffA+1], animF32[poffB+1], pf);
                        psz = mix(animF32[poffA+2], animF32[poffB+2], pf);
                    }
                }
            }

            // Build prev local matrix
            let prevLocalMat = trsToMat4(ptx, pty, ptz, pqx, pqy, pqz, pqw, psx, psy, psz);

            // Hierarchy walk for prev clip — use worldOff as scratch
            let prevParentJ = skelI32[parentOff + pj];
            var prevWorldMat: mat4x4f;
            if (prevParentJ < 0) {
                prevWorldMat = matrices[skelRootIdx] * prevLocalMat;
            } else {
                prevWorldMat = boneMatrices[worldOff + u32(prevParentJ)] * prevLocalMat;
            }
            // Store prev world in scratch
            boneMatrices[worldOff + u32(pj)] = prevWorldMat;

            // Prev bone matrix
            let prevBoneMat = prevWorldMat * matrices[u32(ibmOff) + u32(pj)];

            // Lerp: final = mix(prevBone, currentBone, blendWeight)
            let curBoneMat = boneMatrices[boneOff + u32(pj)];
            let w = inst.blendWeight;
            let omw = 1.0 - w;
            boneMatrices[boneOff + u32(pj)] = mat4x4f(
                curBoneMat[0] * w + prevBoneMat[0] * omw,
                curBoneMat[1] * w + prevBoneMat[1] * omw,
                curBoneMat[2] * w + prevBoneMat[2] * omw,
                curBoneMat[3] * w + prevBoneMat[3] * omw,
            );
        }
    }
}
`;

/** Lightweight compute kernel for skeletal animation (raw WGSL). */
export class SkeletalAnimComputeKernel {
    private device: GPUDevice;
    private pipeline: GPUComputePipeline;
    private bindGroup: GPUBindGroup;
    private workgroupSize: number;

    // Public buffers for sharing with render pipeline
    readonly boneMatrixBuffer: GPUBuffer;
    private uniformBuffer: GPUBuffer;
    private instanceBuffer: GPUBuffer;

    constructor(
        device: GPUDevice,
        packed: PackedAnimationData,
        maxInstances: number,
        maxTotalBones: number,
    ) {
        this.device = device;
        this.workgroupSize = WORKGROUP_SIZE;

        // --- Pack data (same layout as before) ---
        const numSkins = packed.skins.length;
        const numClips = packed.clips.length;
        const numChannels = packed.channels.length;
        const skinEntrySize = 10;
        const clipEntrySize = 4;
        const channelEntrySize = 4;

        const skinEnd = numSkins * skinEntrySize;
        const parentEnd = skinEnd + packed.parentIndices.length;
        const topoEnd = parentEnd + packed.topoOrder.length;
        const clipEnd = topoEnd + numClips * clipEntrySize;
        const channelEnd = clipEnd + numChannels * channelEntrySize;
        const jointLookupEnd = channelEnd + packed.jointChannelLookup.length;

        const clipTableOffset = topoEnd;
        const channelTableOffset = clipEnd;
        const jointLookupOffset = channelEnd;

        // Pack skelI32
        const packedSkelI32 = new Int32Array(jointLookupEnd || 1);
        for (let s = 0; s < numSkins; s++) {
            const sk = packed.skins[s];
            const base = s * skinEntrySize;
            packedSkelI32[base + 0] = sk.jointCount;
            packedSkelI32[base + 1] = skinEnd + sk.parentOffset;
            packedSkelI32[base + 2] = parentEnd + sk.topoOffset;
            packedSkelI32[base + 3] = sk.ibmOffset;
            packedSkelI32[base + 4] = sk.restTRSOffset * 10;
            packedSkelI32[base + 5] = sk.skelRootMatIndex;
            packedSkelI32[base + 6] = sk.clipOffset;          // global clip index offset
            packedSkelI32[base + 7] = jointLookupOffset + sk.jointLookupStart; // absolute lookup offset in skelI32
            packedSkelI32[base + 8] = 0;
            packedSkelI32[base + 9] = 0;
        }
        for (let i = 0; i < packed.parentIndices.length; i++) packedSkelI32[skinEnd + i] = packed.parentIndices[i];
        for (let i = 0; i < packed.topoOrder.length; i++) packedSkelI32[parentEnd + i] = packed.topoOrder[i];

        const dv = new DataView(packedSkelI32.buffer);
        for (let c = 0; c < numClips; c++) {
            const cl = packed.clips[c];
            const base = topoEnd + c * clipEntrySize;
            packedSkelI32[base + 0] = cl.channelStart;
            packedSkelI32[base + 1] = cl.channelCount;
            dv.setFloat32(base * 4 + 8, cl.duration, true);
            packedSkelI32[base + 3] = cl.looping;
        }
        for (let c = 0; c < numChannels; c++) {
            const ch = packed.channels[c];
            const base = clipEnd + c * channelEntrySize;
            packedSkelI32[base + 0] = ch.jointIndex;
            packedSkelI32[base + 1] = ch.pathAndInterp;
            packedSkelI32[base + 2] = ch.keyframeCount;
            packedSkelI32[base + 3] = ch.dataOffset;
        }

        // Pack joint channel lookup
        for (let i = 0; i < packed.jointChannelLookup.length; i++) {
            packedSkelI32[channelEnd + i] = packed.jointChannelLookup[i];
        }

        // Pack animF32
        const keyframeDataSize = packed.keyframeData.length;
        const restTRSOffset = keyframeDataSize;
        const packedAnimF32 = new Float32Array((keyframeDataSize + packed.restTRS.length) || 1);
        for (let i = 0; i < keyframeDataSize; i++) packedAnimF32[i] = packed.keyframeData[i];
        for (let i = 0; i < packed.restTRS.length; i++) packedAnimF32[keyframeDataSize + i] = packed.restTRS[i];

        // Update offsets
        const totalIBM = packed.ibmData.length / 16;
        for (let s = 0; s < numSkins; s++) {
            packedSkelI32[s * skinEntrySize + 5] += totalIBM;
            packedSkelI32[s * skinEntrySize + 4] += restTRSOffset;
        }

        // Pack matrices
        const totalSkelRoot = packed.skelRootMats.length / 16;
        const totalMats = (totalIBM + totalSkelRoot) || 1;
        const matFloats = new Float32Array(totalMats * 16);
        for (let i = 0; i < packed.ibmData.length; i++) matFloats[i] = packed.ibmData[i];
        for (let i = 0; i < packed.skelRootMats.length; i++) matFloats[totalIBM * 16 + i] = packed.skelRootMats[i];

        // --- Create GPU buffers ---
        const createBuf = (data: ArrayBuffer, usage: number) => {
            const buf = device.createBuffer({ size: Math.max(data.byteLength, 16), usage, mappedAtCreation: true });
            new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
            buf.unmap();
            return buf;
        };

        this.uniformBuffer = device.createBuffer({
            size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.instanceBuffer = device.createBuffer({
            size: Math.max(maxInstances * 32, 32), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const skelBuf = createBuf(packedSkelI32.buffer, GPUBufferUsage.STORAGE);
        const animBuf = createBuf(packedAnimF32.buffer, GPUBufferUsage.STORAGE);
        const matBuf = device.createBuffer({
            size: Math.max(matFloats.byteLength, 16),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(matBuf, 0, matFloats);
        this.boneMatrixBuffer = device.createBuffer({
            size: maxTotalBones * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        // --- Create pipeline ---
        const module = device.createShaderModule({ code: WGSL_SHADER });
        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        this.pipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module, entryPoint: 'main' },
        });
        this.bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.instanceBuffer } },
                { binding: 2, resource: { buffer: skelBuf } },
                { binding: 3, resource: { buffer: animBuf } },
                { binding: 4, resource: { buffer: matBuf } },
                { binding: 5, resource: { buffer: this.boneMatrixBuffer } },
            ],
        });

        // Write initial uniform offsets
        const uniformData = new Uint32Array([0, clipTableOffset, channelTableOffset, jointLookupOffset]);
        device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    }

    /** Upload instance states. Call before encodeComputePass. */
    upload(instanceData: ArrayBuffer, instanceCount: number, byteLength: number): void {
        const u = new Uint32Array([instanceCount]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
        this.device.queue.writeBuffer(this.instanceBuffer, 0, instanceData, 0, byteLength);
        this._instanceCount = instanceCount;
    }

    /** Encode compute pass into an existing encoder (avoids separate submission overhead). */
    encodeComputePass(encoder: GPUCommandEncoder): void {
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._instanceCount / WORKGROUP_SIZE));
        pass.end();
    }

    private _instanceCount = 0;

    destroy(): void {
        this.uniformBuffer.destroy();
        this.instanceBuffer.destroy();
        this.boneMatrixBuffer.destroy();
    }
}

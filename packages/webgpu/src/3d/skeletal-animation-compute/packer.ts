/**
 * Packs animation data into flat typed arrays for GPU consumption.
 * Separated from the kernel so packing logic can be tested independently.
 */
import type { PackedAnimationData } from '../gltf-skin-parser';

export interface PackedBuffers {
    skelI32: Int32Array;
    animF32: Float32Array;
    matFloats: Float32Array;
    clipTableOffset: number;
    channelTableOffset: number;
    jointLookupOffset: number;
    totalMats: number;
}

/**
 * Layout of skelI32 (flat i32 array):
 *   [0..S*10)         skin entries (10 i32 each)
 *   [skinEnd..)       parent indices
 *   [parentEnd..)     topo order
 *   [topoEnd..)       clip entries (4 i32 each)
 *   [clipEnd..)       channel entries (4 i32 each)
 *   [channelEnd..)    per-joint channel lookup (2 i32 per joint per clip)
 *
 * Layout of animF32 (flat f32 array):
 *   [0..K)            keyframe data
 *   [K..)             rest pose TRS (10 floats per joint)
 *
 * Layout of matFloats (flat f32, read as mat4x4f):
 *   [0..IBM)          inverse bind matrices
 *   [IBM..)           skeleton root matrices
 */
export function packAnimationData(packed: PackedAnimationData): PackedBuffers {
    const numSkins = packed.skins.length;
    const numClips = packed.clips.length;
    const numChannels = packed.channels.length;
    const SKIN_ENTRY = 10;
    const CLIP_ENTRY = 4;
    const CH_ENTRY = 4;

    const skinEnd = numSkins * SKIN_ENTRY;
    const parentEnd = skinEnd + packed.parentIndices.length;
    const topoEnd = parentEnd + packed.topoOrder.length;
    const clipEnd = topoEnd + numClips * CLIP_ENTRY;
    const channelEnd = clipEnd + numChannels * CH_ENTRY;
    const jointLookupEnd = channelEnd + packed.jointChannelLookup.length;

    const clipTableOffset = topoEnd;
    const channelTableOffset = clipEnd;
    const jointLookupOffset = channelEnd;

    // --- skelI32 ---
    const skelI32 = new Int32Array(jointLookupEnd || 1);

    for (let s = 0; s < numSkins; s++) {
        const sk = packed.skins[s];
        const base = s * SKIN_ENTRY;
        skelI32[base + 0] = sk.jointCount;
        skelI32[base + 1] = skinEnd + sk.parentOffset;
        skelI32[base + 2] = parentEnd + sk.topoOffset;
        skelI32[base + 3] = sk.ibmOffset;
        skelI32[base + 4] = sk.restTRSOffset * 10;
        skelI32[base + 5] = sk.skelRootMatIndex;
        skelI32[base + 6] = sk.clipOffset;
        skelI32[base + 7] = jointLookupOffset + sk.jointLookupStart;
        skelI32[base + 8] = 0;
        skelI32[base + 9] = 0;
    }

    for (let i = 0; i < packed.parentIndices.length; i++) skelI32[skinEnd + i] = packed.parentIndices[i];
    for (let i = 0; i < packed.topoOrder.length; i++) skelI32[parentEnd + i] = packed.topoOrder[i];

    const dv = new DataView(skelI32.buffer);
    for (let c = 0; c < numClips; c++) {
        const cl = packed.clips[c];
        const base = topoEnd + c * CLIP_ENTRY;
        skelI32[base + 0] = cl.channelStart;
        skelI32[base + 1] = cl.channelCount;
        dv.setFloat32(base * 4 + 8, cl.duration, true);
        skelI32[base + 3] = cl.looping;
    }

    for (let c = 0; c < numChannels; c++) {
        const ch = packed.channels[c];
        const base = clipEnd + c * CH_ENTRY;
        skelI32[base + 0] = ch.jointIndex;
        skelI32[base + 1] = ch.pathAndInterp;
        skelI32[base + 2] = ch.keyframeCount;
        skelI32[base + 3] = ch.dataOffset;
    }

    for (let i = 0; i < packed.jointChannelLookup.length; i++) {
        skelI32[channelEnd + i] = packed.jointChannelLookup[i];
    }

    // --- animF32 ---
    const keyframeDataSize = packed.keyframeData.length;
    const restTRSOffset = keyframeDataSize;
    const animF32 = new Float32Array((keyframeDataSize + packed.restTRS.length) || 1);
    for (let i = 0; i < keyframeDataSize; i++) animF32[i] = packed.keyframeData[i];
    for (let i = 0; i < packed.restTRS.length; i++) animF32[keyframeDataSize + i] = packed.restTRS[i];

    // Update skin offsets
    const totalIBM = packed.ibmData.length / 16;
    for (let s = 0; s < numSkins; s++) {
        skelI32[s * SKIN_ENTRY + 5] += totalIBM;
        skelI32[s * SKIN_ENTRY + 4] += restTRSOffset;
    }

    // --- matFloats ---
    const totalSkelRoot = packed.skelRootMats.length / 16;
    const totalMats = (totalIBM + totalSkelRoot) || 1;
    const matFloats = new Float32Array(totalMats * 16);
    for (let i = 0; i < packed.ibmData.length; i++) matFloats[i] = packed.ibmData[i];
    for (let i = 0; i < packed.skelRootMats.length; i++) matFloats[totalIBM * 16 + i] = packed.skelRootMats[i];

    return { skelI32, animF32, matFloats, clipTableOffset, channelTableOffset, jointLookupOffset, totalMats };
}

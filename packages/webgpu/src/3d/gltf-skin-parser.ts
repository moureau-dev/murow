/**
 * glTF skin + animation parser.
 *
 * Pure functions that extract skeletal data from parsed glTF JSON + binary buffers.
 * No GPU resources — just typed arrays ready for the renderer/animation controller.
 */
import { nodeToMat4, mat4MulNew, mat4IdentityNew } from '../core/math';

// --- Types ---

export interface SkinData {
    jointCount: number;
    /** Node indices for each joint (into the glTF node array). */
    jointNodeIndices: Uint16Array;
    /** Inverse bind matrices — jointCount * 16 floats (column-major mat4). */
    inverseBindMatrices: Float32Array;
    /** Parent joint index for each joint (-1 for roots). Index into *this* joint list, not the node array. */
    parentJointIndices: Int16Array;
    /** World matrix of the skeleton root (non-joint ancestors of root joints). Column-major mat4, 16 floats. Null if identity. */
    skeletonRootMatrix: Float32Array | null;
}

export interface AnimationChannel {
    /** Index into the skin's joint list (not node index). */
    jointIndex: number;
    path: 'translation' | 'rotation' | 'scale';
    timestamps: Float32Array;
    /** vec3 for translation/scale, vec4 (quaternion xyzw) for rotation. */
    values: Float32Array;
    interpolation: 'LINEAR' | 'STEP';
}

export interface AnimationClipData {
    name: string;
    duration: number;
    channels: AnimationChannel[];
}

export interface PrimitiveSkinAttributes {
    /** Joint indices — vertexCount * 4. */
    joints: Uint16Array;
    /** Joint weights — vertexCount * 4. */
    weights: Float32Array;
}

// --- Accessor helper type (matches what loadGltf uses) ---

export type AccessorReader = (accessorIndex: number) => {
    data: Float32Array | Uint16Array | Uint32Array | Uint8Array;
    count: number;
    elementSize: number;
};

// --- Parser functions ---

/**
 * Parse skin data from a glTF skin definition.
 */
export function parseSkin(
    gltf: any,
    skinIndex: number,
    getAccessorData: AccessorReader,
): SkinData {
    const skin = gltf.skins[skinIndex];
    const joints: number[] = skin.joints;
    const jointCount = joints.length;

    // Inverse bind matrices
    const ibmAccess = getAccessorData(skin.inverseBindMatrices);
    const inverseBindMatrices = new Float32Array(ibmAccess.data as Float32Array);

    // Joint node indices
    const jointNodeIndices = new Uint16Array(joints);

    // Build node → joint index map
    const nodeToJoint = new Map<number, number>();
    for (let j = 0; j < jointCount; j++) {
        nodeToJoint.set(joints[j], j);
    }

    // Build parent map from node hierarchy
    const nodeParent = new Map<number, number>();
    for (let i = 0; i < gltf.nodes.length; i++) {
        const children = gltf.nodes[i].children;
        if (children) {
            for (const child of children) {
                nodeParent.set(child, i);
            }
        }
    }

    // Compute parent joint index for each joint
    const parentJointIndices = new Int16Array(jointCount).fill(-1);
    for (let j = 0; j < jointCount; j++) {
        let parentNode = nodeParent.get(joints[j]);
        // Walk up until we find a node that's also a joint (or reach root)
        while (parentNode !== undefined) {
            const parentJoint = nodeToJoint.get(parentNode);
            if (parentJoint !== undefined) {
                parentJointIndices[j] = parentJoint;
                break;
            }
            parentNode = nodeParent.get(parentNode);
        }
    }

    // Compute skeleton root matrix: accumulate transforms of non-joint ancestors
    // of any root joint (parentJointIndices[j] === -1)
    let skeletonRootMatrix: Float32Array | null = null;
    for (let j = 0; j < jointCount; j++) {
        if (parentJointIndices[j] !== -1) continue;
        // Walk up from root joint's parent node through non-joint ancestors
        let ancestorNode = nodeParent.get(joints[j]);
        const ancestorChain: number[] = [];
        while (ancestorNode !== undefined && !nodeToJoint.has(ancestorNode)) {
            ancestorChain.push(ancestorNode);
            ancestorNode = nodeParent.get(ancestorNode);
        }
        if (ancestorChain.length > 0) {
            // Multiply ancestor transforms from root down
            skeletonRootMatrix = mat4IdentityNew();
            for (let i = ancestorChain.length - 1; i >= 0; i--) {
                const nodeMat = nodeToMat4(gltf.nodes[ancestorChain[i]]);
                skeletonRootMatrix = mat4MulNew(skeletonRootMatrix, nodeMat);
            }
        }
        break; // only need one root joint's ancestors
    }

    return {
        jointCount,
        jointNodeIndices,
        inverseBindMatrices,
        parentJointIndices,
        skeletonRootMatrix,
    };
}

/**
 * Parse animation clips that target joints in a skin.
 */
export function parseAnimations(
    gltf: any,
    skinData: SkinData,
    getAccessorData: AccessorReader,
): AnimationClipData[] {
    if (!gltf.animations?.length) return [];

    // Build node → joint index map
    const nodeToJoint = new Map<number, number>();
    for (let j = 0; j < skinData.jointCount; j++) {
        nodeToJoint.set(skinData.jointNodeIndices[j], j);
    }

    const clips: AnimationClipData[] = [];

    for (const anim of gltf.animations) {
        const channels: AnimationChannel[] = [];
        let maxTime = 0;

        for (const channel of anim.channels) {
            const targetNode = channel.target.node;
            const jointIndex = nodeToJoint.get(targetNode);
            if (jointIndex === undefined) continue; // not a joint in this skin

            const path = channel.target.path as string;
            if (path !== 'translation' && path !== 'rotation' && path !== 'scale') continue;

            const sampler = anim.samplers[channel.sampler];
            const interpolation = (sampler.interpolation ?? 'LINEAR') as 'LINEAR' | 'STEP';

            // Skip CUBICSPLINE for now
            if (interpolation !== 'LINEAR' && interpolation !== 'STEP') continue;

            const inputAccess = getAccessorData(sampler.input);
            const timestamps = new Float32Array(inputAccess.data as Float32Array);

            const outputAccess = getAccessorData(sampler.output);
            const values = new Float32Array(outputAccess.data as Float32Array);

            if (timestamps.length > 0) {
                const lastTime = timestamps[timestamps.length - 1];
                if (lastTime > maxTime) maxTime = lastTime;
            }

            channels.push({
                jointIndex,
                path: path as 'translation' | 'rotation' | 'scale',
                timestamps,
                values,
                interpolation,
            });
        }

        if (channels.length > 0) {
            clips.push({
                name: anim.name ?? `animation_${clips.length}`,
                duration: maxTime,
                channels,
            });
        }
    }

    return clips;
}

/**
 * Extract JOINTS_0 and WEIGHTS_0 from a glTF primitive.
 * Returns null if the primitive has no skinning attributes.
 */
export function parsePrimitiveSkinAttributes(
    primitive: any,
    getAccessorData: AccessorReader,
): PrimitiveSkinAttributes | null {
    if (primitive.attributes.JOINTS_0 === undefined || primitive.attributes.WEIGHTS_0 === undefined) {
        return null;
    }

    const jointsAccess = getAccessorData(primitive.attributes.JOINTS_0);
    const weightsAccess = getAccessorData(primitive.attributes.WEIGHTS_0);

    // Convert joints to Uint16Array (may come as Uint8Array)
    const joints = jointsAccess.data instanceof Uint16Array
        ? jointsAccess.data
        : new Uint16Array(jointsAccess.data);

    // Convert weights to Float32Array — handle normalized byte/short formats
    let weights: Float32Array;
    if (weightsAccess.data instanceof Float32Array) {
        weights = weightsAccess.data;
    } else if (weightsAccess.data instanceof Uint8Array) {
        // Normalized unsigned byte: divide by 255
        weights = new Float32Array(weightsAccess.data.length);
        for (let i = 0; i < weightsAccess.data.length; i++) {
            weights[i] = weightsAccess.data[i] / 255;
        }
    } else if (weightsAccess.data instanceof Uint16Array) {
        // Normalized unsigned short: divide by 65535
        weights = new Float32Array(weightsAccess.data.length);
        for (let i = 0; i < weightsAccess.data.length; i++) {
            weights[i] = weightsAccess.data[i] / 65535;
        }
    } else {
        weights = new Float32Array(weightsAccess.data as any);
    }

    return { joints, weights };
}

/**
 * Get a node's local TRS as [tx, ty, tz, qx, qy, qz, qw, sx, sy, sz].
 */
export function getNodeTRS(node: any): Float32Array {
    const trs = new Float32Array(10);

    if (node.matrix) {
        // Decompose matrix to TRS — for now, just extract translation and assume identity rotation/scale
        // Full decomposition is complex; glTF best practice is to use TRS directly
        trs[0] = node.matrix[12];
        trs[1] = node.matrix[13];
        trs[2] = node.matrix[14];
        trs[3] = 0; trs[4] = 0; trs[5] = 0; trs[6] = 1;
        trs[7] = 1; trs[8] = 1; trs[9] = 1;
        return trs;
    }

    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];

    trs[0] = t[0]; trs[1] = t[1]; trs[2] = t[2];
    trs[3] = r[0]; trs[4] = r[1]; trs[5] = r[2]; trs[6] = r[3];
    trs[7] = s[0]; trs[8] = s[1]; trs[9] = s[2];

    return trs;
}

// =============================================================================
// GPU buffer packing — flatten animation data for compute shader consumption
// =============================================================================

/** Packed GPU-ready animation data for all skins/clips loaded so far. */
export interface PackedAnimationData {
    /** Flat channel descriptors: [jointIndex, pathAndInterp, keyframeCount, dataOffset] per channel */
    channels: { jointIndex: number; pathAndInterp: number; keyframeCount: number; dataOffset: number }[];
    /** Flat keyframe data: timestamps then values for each channel */
    keyframeData: number[];
    /** Clip descriptors: [channelStart, channelCount, duration, loop] */
    clips: { channelStart: number; channelCount: number; duration: number; looping: number }[];
    /** Per-skin entries */
    skins: { jointCount: number; parentOffset: number; topoOffset: number; ibmOffset: number; restTRSOffset: number; skelRootMatIndex: number; clipOffset: number; jointLookupStart: number }[];
    /** Flat parent joint indices (i32), all skins concatenated */
    parentIndices: number[];
    /** Flat topological order (u32), all skins concatenated */
    topoOrder: number[];
    /** Flat inverse bind matrices (mat4x4, 16 floats each), all skins concatenated */
    ibmData: number[];
    /** Flat rest pose TRS (10 floats per joint), all skins concatenated */
    restTRS: number[];
    /** Skeleton root matrices (16 floats each), one per skin */
    skelRootMats: number[];
    /** Per-joint channel lookup: [clipIdx * maxJoints * 2 + joint * 2] = (channelStart, channelCount) */
    jointChannelLookup: number[];
}

export function createPackedAnimationData(): PackedAnimationData {
    return {
        channels: [],
        keyframeData: [],
        clips: [],
        skins: [],
        parentIndices: [],
        topoOrder: [],
        ibmData: [],
        restTRS: [],
        skelRootMats: [],
        jointChannelLookup: [],
    };
}

/**
 * Pack a skin + its animations into the flat GPU buffers.
 * Returns the skin index within the packed data.
 */
export function packSkinAndAnimations(
    packed: PackedAnimationData,
    skinData: SkinData,
    clips: AnimationClipData[],
    gltfNodes: any[],
): number {
    const skinIndex = packed.skins.length;
    const jc = skinData.jointCount;

    // Pack skin entry
    const parentOffset = packed.parentIndices.length;
    const topoOffset = packed.topoOrder.length;
    const ibmOffset = packed.ibmData.length / 16;
    const restTRSOffset = packed.restTRS.length / 10;
    const skelRootMatIndex = packed.skelRootMats.length / 16;

    // Parent indices
    for (let j = 0; j < jc; j++) {
        packed.parentIndices.push(skinData.parentJointIndices[j]);
    }

    // Topological order
    const visited = new Uint8Array(jc);
    const visit = (j: number) => {
        if (visited[j]) return;
        visited[j] = 1;
        const parent = skinData.parentJointIndices[j];
        if (parent !== -1) visit(parent);
        packed.topoOrder.push(j);
    };
    for (let j = 0; j < jc; j++) visit(j);

    // Inverse bind matrices
    for (let i = 0; i < skinData.inverseBindMatrices.length; i++) {
        packed.ibmData.push(skinData.inverseBindMatrices[i]);
    }

    // Rest pose TRS
    for (let j = 0; j < jc; j++) {
        const trs = getNodeTRS(gltfNodes[skinData.jointNodeIndices[j]]);
        for (let k = 0; k < 10; k++) packed.restTRS.push(trs[k]);
    }

    // Skeleton root matrix
    if (skinData.skeletonRootMatrix) {
        for (let i = 0; i < 16; i++) packed.skelRootMats.push(skinData.skeletonRootMatrix[i]);
    } else {
        // Identity
        const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
        for (let i = 0; i < 16; i++) packed.skelRootMats.push(id[i]);
    }

    const clipOffset = packed.clips.length; // global clip index where this skin's clips start
    const jointLookupStart = packed.jointChannelLookup.length; // where this skin's lookup starts

    packed.skins.push({ jointCount: jc, parentOffset, topoOffset, ibmOffset, restTRSOffset, skelRootMatIndex, clipOffset, jointLookupStart });

    // Build node → joint index map for this skin
    const nodeToJoint = new Map<number, number>();
    for (let j = 0; j < jc; j++) {
        nodeToJoint.set(skinData.jointNodeIndices[j], j);
    }

    // Pack clips — sort channels by joint for GPU-friendly access
    for (const clip of clips) {
        const channelStart = packed.channels.length;

        // Sort channels by joint index
        const sortedChannels = [...clip.channels].sort((a, b) => a.jointIndex - b.jointIndex);

        for (const ch of sortedChannels) {
            const pathCode = ch.path === 'translation' ? 0 : ch.path === 'rotation' ? 1 : 2;
            const isStep = ch.interpolation === 'STEP' ? 4 : 0;
            const dataOffset = packed.keyframeData.length;
            const n = ch.timestamps.length;
            const compCount = ch.path === 'rotation' ? 4 : 3;

            for (let i = 0; i < n; i++) packed.keyframeData.push(ch.timestamps[i]);
            for (let i = 0; i < n * compCount; i++) packed.keyframeData.push(ch.values[i]);

            packed.channels.push({
                jointIndex: ch.jointIndex,
                pathAndInterp: pathCode | isStep,
                keyframeCount: n,
                dataOffset,
            });
        }

        // Build per-joint channel lookup: for each joint, (startIdx, count) within this clip's channels
        // Stored in packed.jointChannelLookup as [clipIdx * maxJoints * 2 + joint * 2] = start, count
        const clipChannelCount = sortedChannels.length;
        let ci = 0;
        for (let j = 0; j < jc; j++) {
            const lookupStart = ci;
            while (ci < clipChannelCount && sortedChannels[ci].jointIndex === j) ci++;
            packed.jointChannelLookup.push(channelStart + lookupStart); // absolute channel index
            packed.jointChannelLookup.push(ci - lookupStart); // count
        }

        packed.clips.push({
            channelStart,
            channelCount: clipChannelCount,
            duration: clip.duration,
            looping: 1,
        });
    }

    return skinIndex;
}


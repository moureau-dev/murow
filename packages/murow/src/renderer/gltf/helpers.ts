/**
 * Pure glTF parsing helpers — container decoding, primitive extraction, and
 * transform baking. No fetch, no GPU, no closure state.
 */
import type { SkinData, AccessorReader } from './skin-parser';

/**
 * Decode a fetched glTF payload — either a JSON .gltf or a binary .glb container —
 * into the parsed JSON object and (for .glb) the embedded binary chunk.
 */
export function decodeGltfContainer(arrayBuffer: ArrayBuffer, url: string): { gltf: any; glbBinaryChunk: ArrayBuffer | null } {
    const GLB_MAGIC = 0x46546C67;       // "glTF"
    const CHUNK_JSON = 0x4E4F534A;      // "JSON"
    const CHUNK_BIN = 0x004E4942;       // "BIN\0"

    const magic = new Uint32Array(arrayBuffer, 0, 1)[0];
    if (magic !== GLB_MAGIC) {
        return { gltf: JSON.parse(new TextDecoder().decode(arrayBuffer)), glbBinaryChunk: null };
    }

    let gltf: any;
    let glbBinaryChunk: ArrayBuffer | null = null;
    let offset = 12; // past 12-byte GLB header

    while (offset < arrayBuffer.byteLength) {
        const chunkLength = new Uint32Array(arrayBuffer, offset, 1)[0];
        const chunkType = new Uint32Array(arrayBuffer, offset + 4, 1)[0];
        offset += 8;

        if (chunkType === CHUNK_JSON) {
            const jsonBytes = new Uint8Array(arrayBuffer, offset, chunkLength);
            gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
        } else if (chunkType === CHUNK_BIN) {
            glbBinaryChunk = arrayBuffer.slice(offset, offset + chunkLength);
        }

        offset += chunkLength;
    }

    if (!gltf) throw new Error(`Invalid GLB: no JSON chunk in ${url}`);
    return { gltf, glbBinaryChunk };
}

/**
 * Validate that every skin referenced by a mesh node is equivalent to the
 * canonical skin (same joint nodes in any order, same IBMs) and build a joint
 * remap from each non-canonical skin's index space into canonical's.
 *
 * Throws if any skin is structurally incompatible — truly independent skeletons
 * in one file are not supported yet.
 */
export function validateAndBuildSkinRemaps(
    gltf: any,
    canonicalSkinIndex: number,
    skinData: SkinData,
    skinJointRemaps: Map<number, Uint16Array>,
    getAccessorData: AccessorReader,
): void {
    const canonicalNodeToJoint = new Map<number, number>();
    for (let j = 0; j < skinData.jointCount; j++) {
        canonicalNodeToJoint.set(skinData.jointNodeIndices[j], j);
    }
    const canonicalIbm = skinData.inverseBindMatrices;

    const referencedSkins = new Set<number>();
    for (const n of gltf.nodes) {
        if (n.mesh !== undefined && n.skin !== undefined) referencedSkins.add(n.skin);
    }

    for (const otherIdx of referencedSkins) {
        if (otherIdx === canonicalSkinIndex) continue;
        const otherSkin = gltf.skins[otherIdx];
        if (!otherSkin) continue;
        const otherJoints: number[] = otherSkin.joints;

        if (otherJoints.length !== skinData.jointCount) {
            throw new Error(
                `glTF has incompatible skins (skin ${otherIdx} has ${otherJoints.length} joints, ` +
                `canonical skin ${canonicalSkinIndex} has ${skinData.jointCount}). ` +
                `Multi-skeleton models are not supported yet.`
            );
        }

        const remap = new Uint16Array(otherJoints.length);
        for (let j = 0; j < otherJoints.length; j++) {
            const canonJ = canonicalNodeToJoint.get(otherJoints[j]);
            if (canonJ === undefined) {
                throw new Error(
                    `glTF skin ${otherIdx} references node ${otherJoints[j]} which is not a joint in ` +
                    `canonical skin ${canonicalSkinIndex}. Multi-skeleton models are not supported yet.`
                );
            }
            remap[j] = canonJ;
        }

        const otherIbmAccess = getAccessorData(otherSkin.inverseBindMatrices);
        const otherIbm = otherIbmAccess.data as Float32Array;
        const EPS = 1e-4;
        for (let j = 0; j < otherJoints.length; j++) {
            const canonJ = remap[j];
            for (let k = 0; k < 16; k++) {
                if (Math.abs(otherIbm[j * 16 + k] - canonicalIbm[canonJ * 16 + k]) > EPS) {
                    throw new Error(
                        `glTF skin ${otherIdx} has different inverse bind matrices than canonical skin ` +
                        `${canonicalSkinIndex}. Multi-skeleton models are not supported yet.`
                    );
                }
            }
        }

        skinJointRemaps.set(otherIdx, remap);
    }
}

/** Remap a primitive's joint indices into canonical joint space, if needed. */
export function remapSkinAttributes(
    attrs: { joints: Uint16Array; weights: Float32Array },
    meshSkinIndex: number | undefined,
    canonicalSkinIndex: number | undefined,
    skinJointRemaps: Map<number, Uint16Array>,
): { joints: Uint16Array; weights: Float32Array } {
    const remap = meshSkinIndex !== canonicalSkinIndex ? skinJointRemaps.get(meshSkinIndex!) : undefined;
    if (!remap) return attrs;

    const remapped = new Uint16Array(attrs.joints.length);
    for (let i = 0; i < attrs.joints.length; i++) {
        remapped[i] = remap[attrs.joints[i]];
    }
    return { joints: remapped, weights: attrs.weights };
}

/** Extract per-primitive vertex attributes (positions, normals, UVs, indices) from glTF accessors. */
export function extractPrimitiveAttributes(
    primitive: any,
    getAccessorData: AccessorReader,
): {
    positions: Float32Array;
    normals: Float32Array | undefined;
    uvs: Float32Array | undefined;
    indices: Uint16Array | Uint32Array | undefined;
} {
    const positions = new Float32Array(getAccessorData(primitive.attributes.POSITION).data as Float32Array);

    const normals = primitive.attributes.NORMAL !== undefined
        ? new Float32Array(getAccessorData(primitive.attributes.NORMAL).data as Float32Array)
        : undefined;

    const uvs = primitive.attributes.TEXCOORD_0 !== undefined
        ? new Float32Array(getAccessorData(primitive.attributes.TEXCOORD_0).data as Float32Array)
        : undefined;

    let indices: Uint16Array | Uint32Array | undefined;
    if (primitive.indices !== undefined) {
        const idxAccess = getAccessorData(primitive.indices);
        indices = idxAccess.data.length > 65535
            ? new Uint32Array(idxAccess.data)
            : new Uint16Array(idxAccess.data);
    }

    return { positions, normals, uvs, indices };
}

/**
 * Bake a column-major mat4 into positions (in place) and re-orient + renormalize
 * normals. Used to fold a non-skinned mesh node's transform into its vertices
 * so the renderer doesn't need to know about per-mesh node transforms.
 */
export function bakeTransformIntoVertices(positions: Float32Array, normals: Float32Array | undefined, mm: Float32Array): void {
    const vertexCount = positions.length / 3;
    for (let v = 0; v < vertexCount; v++) {
        const o = v * 3;
        const px = positions[o], py = positions[o + 1], pz = positions[o + 2];
        positions[o]     = mm[0] * px + mm[4] * py + mm[8]  * pz + mm[12];
        positions[o + 1] = mm[1] * px + mm[5] * py + mm[9]  * pz + mm[13];
        positions[o + 2] = mm[2] * px + mm[6] * py + mm[10] * pz + mm[14];

        if (normals) {
            const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
            const tnx = mm[0] * nx + mm[4] * ny + mm[8]  * nz;
            const tny = mm[1] * nx + mm[5] * ny + mm[9]  * nz;
            const tnz = mm[2] * nx + mm[6] * ny + mm[10] * nz;
            const len = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
            if (len > 0) {
                normals[o]     = tnx / len;
                normals[o + 1] = tny / len;
                normals[o + 2] = tnz / len;
            }
        }
    }
}

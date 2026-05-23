/**
 * glTF parser — fetches a .gltf / .glb URL and returns CPU-side data
 * ready for GPU upload. Pure: no device, no GPU buffers, no renderer state.
 *
 * The renderer's `loadGltf` is a thin wrapper that calls this then uploads
 * the result. Splitting parse from upload lets:
 *   - callers inspect joint counts / vertex totals / skinned-part count
 *     before constructing the renderer (so it can size itself correctly)
 *   - tests verify parsing without a WebGPU device
 *   - parsing run in parallel across many URLs via `Promise.all`
 */
import { nodeToMat4 } from '../math';
import {
    parseSkin,
    parseAnimations,
    parsePrimitiveSkinAttributes,
    type SkinData,
    type AnimationClipData,
    type PrimitiveSkinAttributes,
} from './skin-parser';

/** Per-primitive CPU data ready for upload. */
export interface ParsedGltfPrimitive {
    positions: Float32Array;
    normals?: Float32Array;
    uvs?: Float32Array;
    indices?: Uint16Array | Uint32Array;
    texture?: ImageBitmap;
    /** Present iff the primitive belongs to a skinned mesh. */
    skinAttrs?: PrimitiveSkinAttributes;
    /** True iff this primitive should be loaded as a skinned model. */
    skinned: boolean;
}

/** CPU-side result of parsing a glTF / glb URL. */
export interface ParsedGltf {
    /** Source URL the model was loaded from. */
    src: string;
    /** One entry per primitive that should become a model part. */
    primitives: ParsedGltfPrimitive[];
    /** Skin + filtered animation clips, or null if the model has no skin. */
    skin: { data: SkinData; animClips: AnimationClipData[] } | null;
}

/**
 * Parse a glTF / .glb file from a URL into CPU-side data.
 * Does no GPU work. Safe to call in parallel; safe to call before a renderer exists.
 */
export async function parseGltf(url: string, opts?: { animations?: string[] }): Promise<ParsedGltf> {
    const response = await fetch(url);
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

    let gltf: any;
    let glbBinaryChunk: ArrayBuffer | null = null;

    const arrayBuffer = await response.arrayBuffer();
    const magic = new Uint32Array(arrayBuffer, 0, 1)[0];

    if (magic === 0x46546C67) {
        // GLB: magic "glTF" (little-endian 0x46546C67)
        let offset = 12; // past header

        while (offset < arrayBuffer.byteLength) {
            const chunkLength = new Uint32Array(arrayBuffer, offset, 1)[0];
            const chunkType = new Uint32Array(arrayBuffer, offset + 4, 1)[0];
            offset += 8;

            if (chunkType === 0x4E4F534A) {
                const jsonBytes = new Uint8Array(arrayBuffer, offset, chunkLength);
                gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
            } else if (chunkType === 0x004E4942) {
                glbBinaryChunk = arrayBuffer.slice(offset, offset + chunkLength);
            }

            offset += chunkLength;
        }

        if (!gltf) throw new Error(`Invalid GLB: no JSON chunk in ${url}`);
    } else {
        gltf = JSON.parse(new TextDecoder().decode(arrayBuffer));
    }

    if (!gltf.meshes?.length) throw new Error(`No meshes found in ${url}`);

    // Load binary buffers
    const buffers: ArrayBuffer[] = [];
    for (let i = 0; i < (gltf.buffers?.length ?? 0); i++) {
        const buf = gltf.buffers[i];
        if (glbBinaryChunk && (!buf.uri || buf.uri === '')) {
            buffers.push(glbBinaryChunk);
        } else if (buf.uri) {
            const r = await fetch(baseUrl + buf.uri);
            buffers.push(await r.arrayBuffer());
        }
    }

    const getAccessorData = (accessorIndex: number): { data: Float32Array | Uint16Array | Uint32Array | Uint8Array; count: number; elementSize: number } => {
        const accessor = gltf.accessors[accessorIndex];
        const bufferView = gltf.bufferViews[accessor.bufferView];
        const buffer = buffers[bufferView.buffer];

        const typeMap: Record<number, any> = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
        const byteSizeMap: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
        const sizeMap: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

        const TypedArray = typeMap[accessor.componentType];
        const componentBytes = byteSizeMap[accessor.componentType];
        const elementSize = sizeMap[accessor.type] ?? 1;
        const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const stride = bufferView.byteStride ?? (componentBytes * elementSize);
        const tightStride = componentBytes * elementSize;

        if (stride === tightStride) {
            const data = new TypedArray(buffer, baseOffset, accessor.count * elementSize);
            return { data, count: accessor.count, elementSize };
        }

        const out = new TypedArray(accessor.count * elementSize);
        const src = new Uint8Array(buffer);
        const dst = new Uint8Array(out.buffer);
        for (let i = 0; i < accessor.count; i++) {
            const srcOff = baseOffset + i * stride;
            const dstOff = i * tightStride;
            for (let b = 0; b < tightStride; b++) {
                dst[dstOff + b] = src[srcOff + b];
            }
        }

        return { data: out, count: accessor.count, elementSize };
    };

    // Texture loader (cached by image index)
    const textureCache = new Map<number, ImageBitmap>();
    const loadTexture = async (imageIndex: number): Promise<ImageBitmap | undefined> => {
        if (textureCache.has(imageIndex)) return textureCache.get(imageIndex)!;
        const image = gltf.images?.[imageIndex];
        if (!image) return undefined;

        let blob: Blob | undefined;
        if (image.bufferView !== undefined) {
            const bv = gltf.bufferViews[image.bufferView];
            const buf = buffers[bv.buffer];
            const data = new Uint8Array(buf, bv.byteOffset ?? 0, bv.byteLength);
            blob = new Blob([data], { type: image.mimeType ?? 'image/png' });
        } else if (image.uri) {
            const imgUrl = image.uri.startsWith('data:') ? image.uri : baseUrl + image.uri;
            blob = await (await fetch(imgUrl)).blob();
        }

        if (blob) {
            const bmp = await createImageBitmap(blob);
            textureCache.set(imageIndex, bmp);
            return bmp;
        }
        return undefined;
    };

    // First mesh node — used to look up the skin
    const meshNodeIndex = gltf.nodes?.findIndex((n: any) => n.mesh !== undefined) ?? -1;

    // Detect skin + parse animations
    const skinIndex = meshNodeIndex !== -1 ? gltf.nodes?.[meshNodeIndex]?.skin : undefined;
    let skinData: SkinData | null = null;
    let animClips: AnimationClipData[] = [];

    if (skinIndex !== undefined && gltf.skins?.[skinIndex]) {
        skinData = parseSkin(gltf, skinIndex, getAccessorData);
        animClips = parseAnimations(gltf, skinData, getAccessorData);
        if (opts?.animations) {
            animClips = animClips.filter(clip => opts.animations!.includes(clip.name));
        }
    }

    // Collect mesh node indices in order
    const meshNodeIndices: number[] = [];
    for (let i = 0; i < gltf.nodes.length; i++) {
        if (gltf.nodes[i].mesh !== undefined) meshNodeIndices.push(i);
    }
    const meshIndicesToLoad = meshNodeIndices.length > 0
        ? meshNodeIndices.map((ni: number) => gltf.nodes[ni].mesh as number)
        : [0];

    const primitives: ParsedGltfPrimitive[] = [];

    for (const meshIdx of meshIndicesToLoad) {
        const mesh = gltf.meshes[meshIdx];
        if (!mesh) continue;

        const meshNodeForThis = gltf.nodes.find((n: any) => n.mesh === meshIdx);
        const meshSkinIndex = meshNodeForThis?.skin;
        const isSkinned = skinData !== null && meshSkinIndex !== undefined;

        // Mesh-node transform for non-skinned meshes (e.g. scale [-1,1,1] mirror)
        let thisMeshNodeMatrix: Float32Array | null = null;
        if (meshNodeForThis && !isSkinned) {
            if (meshNodeForThis.scale || meshNodeForThis.rotation || meshNodeForThis.translation || meshNodeForThis.matrix) {
                thisMeshNodeMatrix = nodeToMat4(meshNodeForThis);
            }
        }

        for (const primitive of mesh.primitives) {
            const posAccess = getAccessorData(primitive.attributes.POSITION);
            const positions = new Float32Array(posAccess.data as Float32Array);

            let normals: Float32Array | undefined;
            if (primitive.attributes.NORMAL !== undefined) {
                normals = new Float32Array(getAccessorData(primitive.attributes.NORMAL).data as Float32Array);
            }

            let uvs: Float32Array | undefined;
            if (primitive.attributes.TEXCOORD_0 !== undefined) {
                uvs = new Float32Array(getAccessorData(primitive.attributes.TEXCOORD_0).data as Float32Array);
            }

            let indices: Uint16Array | Uint32Array | undefined;
            if (primitive.indices !== undefined) {
                const idxAccess = getAccessorData(primitive.indices);
                indices = idxAccess.data.length > 65535
                    ? new Uint32Array(idxAccess.data)
                    : new Uint16Array(idxAccess.data);
            }

            // Bake mesh-node transform into positions/normals (non-skinned only)
            if (thisMeshNodeMatrix && !isSkinned) {
                const mm = thisMeshNodeMatrix;
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
                            normals[o] = tnx / len;
                            normals[o + 1] = tny / len;
                            normals[o + 2] = tnz / len;
                        }
                    }
                }
            }

            let texture: ImageBitmap | undefined;
            if (primitive.material !== undefined) {
                const material = gltf.materials?.[primitive.material];
                const texIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
                if (texIndex !== undefined && gltf.textures?.[texIndex]) {
                    texture = await loadTexture(gltf.textures[texIndex].source);
                }
            }

            let skinAttrs: PrimitiveSkinAttributes | undefined;
            let skinned = false;
            if (isSkinned) {
                const attrs = parsePrimitiveSkinAttributes(primitive, getAccessorData);
                if (attrs) {
                    skinAttrs = attrs;
                    skinned = true;
                }
            }

            primitives.push({ positions, normals, uvs, indices, texture, skinAttrs, skinned });
        }
    }

    return {
        src: url,
        primitives,
        skin: skinData ? { data: skinData, animClips } : null,
    };
}

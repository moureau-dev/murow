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
    decodeAnimationClip,
    buildNodeToJointMap,
    type SkinData,
    type AnimationClipData,
    type PrimitiveSkinAttributes,
    type AccessorReader,
} from './skin-parser';
import {
    bakeTransformIntoVertices,
    decodeGltfContainer,
    extractPrimitiveAttributes,
    remapSkinAttributes,
    validateAndBuildSkinRemaps,
} from './helpers';

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

/**
 * Retained parser state for decoding more clips after the initial `parseGltf`.
 * Null when the spec opted out via `freezeAnimations: true`.
 */
export interface ParsedGltfSource {
    readonly availableAnimations: readonly string[];
    /** Returns null if the clip has no channels targeting joints in this skin. Throws on unknown name. */
    decodeAnimation(name: string): AnimationClipData | null;
}

/** Skin + filtered animation clips. Mutated by lazy `loadAnimations` / `unloadAnimations`. */
export interface ParsedGltfSkin {
    data: SkinData;
    animClips: AnimationClipData[];
}

/** CPU-side result of parsing a glTF / glb URL. */
export interface ParsedGltf {
    /** Source URL the model was loaded from. */
    src: string;
    /** One entry per primitive that should become a model part. */
    primitives: ParsedGltfPrimitive[];
    /** Skin + filtered animation clips, or null if the model has no skin. */
    skin: ParsedGltfSkin | null;
    /** Retained parser state for lazy clip decoding. Null when the spec passed `freezeAnimations: true`. */
    source: ParsedGltfSource | null;
}

export interface ParseGltfOptions {
    /** Whitelist of clip names to keep. */
    animations?: string[];
    /** Release the source JSON + accessor reader after parse. Disables lazy load. */
    freezeAnimations?: boolean;
}

/**
 * Parse a glTF / .glb file from a URL into CPU-side data.
 * Does no GPU work. Safe to call in parallel; safe to call before a renderer exists.
 */
export async function parseGltf(url: string, opts?: ParseGltfOptions): Promise<ParsedGltf> {
    const response = await fetch(url);
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const arrayBuffer = await response.arrayBuffer();

    const { gltf, glbBinaryChunk } = decodeGltfContainer(arrayBuffer, url);

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

    const getAccessorData: AccessorReader = (accessorIndex: number) => {
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

    const skinnedMeshNodeIndex = gltf.nodes?.findIndex((n: any) => n.mesh !== undefined && n.skin !== undefined) ?? -1;
    const canonicalSkinIndex = skinnedMeshNodeIndex !== -1 ? gltf.nodes[skinnedMeshNodeIndex].skin : undefined;
    let skinData: SkinData | null = null;
    let animClips: AnimationClipData[] = [];
    const skinJointRemaps = new Map<number, Uint16Array>();

    if (canonicalSkinIndex !== undefined && gltf.skins?.[canonicalSkinIndex]) {
        skinData = parseSkin(gltf, canonicalSkinIndex, getAccessorData);
        animClips = parseAnimations(gltf, skinData, getAccessorData);
        if (opts?.animations) {
            animClips = animClips.filter(clip => opts.animations!.includes(clip.name));
        }

        validateAndBuildSkinRemaps(gltf, canonicalSkinIndex, skinData, skinJointRemaps, getAccessorData);
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
            const { positions, normals, uvs, indices } = extractPrimitiveAttributes(primitive, getAccessorData);

            if (thisMeshNodeMatrix && !isSkinned) {
                bakeTransformIntoVertices(positions, normals, thisMeshNodeMatrix);
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
                    skinAttrs = remapSkinAttributes(attrs, meshSkinIndex, canonicalSkinIndex, skinJointRemaps);
                    skinned = true;
                }
            }

            primitives.push({ positions, normals, uvs, indices, texture, skinAttrs, skinned });
        }
    }

    let source: ParsedGltfSource | null = null;
    if (!opts?.freezeAnimations && skinData) {
        const allAnims: any[] = gltf.animations ?? [];
        const availableAnimations: readonly string[] = allAnims.map(
            (a: any, i: number) => a.name ?? `animation_${i}`
        );
        const nodeToJoint = buildNodeToJointMap(skinData);
        source = {
            availableAnimations,
            decodeAnimation(name: string): AnimationClipData | null {
                const idx = allAnims.findIndex((a: any, i: number) => (a.name ?? `animation_${i}`) === name);
                if (idx < 0) throw new Error(`glTF ${url} has no animation named '${name}'`);
                return decodeAnimationClip(allAnims[idx], `animation_${idx}`, nodeToJoint, getAccessorData);
            },
        };
    }

    return {
        src: url,
        primitives,
        skin: skinData ? { data: skinData, animClips } : null,
        source,
    };
}

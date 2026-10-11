import type {
    AssetBucket,
    ConePrefab,
    CubePrefab,
    CubeUvMode,
    CylinderPrefab,
    MeshPrefab,
    ParsedGltf,
    PlanePrefab,
    PrefabBucket3D,
    SpherePrefab,
    TexturePrefab,
} from 'murow/renderer';
import type { GltfModel, ModelData, ModelHandle } from '../../types';
import type { ModelLibrary } from '../../internals/model-library';
import type { RendererCore } from '../../core/renderer-core';
import { setPrefabHandle } from '../instances/prefab-handle';

/**
 * The skeletal runtime surface `upload` needs: attach the clip-resync
 * coordinator and register skinned prefabs.
 */
export interface PrefabUploadAnimation {
    attachBucket(bucket: PrefabBucket3D): void;
    registerSkin(prefabId: string, skinIndex: number): void;
}

/**
 * ModelsManager is the public facade for creating and loading GPU meshes. It
 * wraps `core.models` (`ModelLibrary`); the returned `ModelHandle` is passed to
 * `renderer.instances.add`.
 */
export class ModelsManager {
    private readonly library: ModelLibrary;

    constructor(
        private readonly core: RendererCore,
        private readonly animation: PrefabUploadAnimation,
    ) {
        this.library = core.models;
    }

    /** Create a flat grid mesh on the XZ plane at Y=0. */
    createGrid(opts: { size?: number; step?: number; lineWidth?: number } = {}): ModelHandle {
        return this.library.createGrid(opts);
    }

    /** Create a cube mesh centered at the origin. */
    createCube(opts: { size?: number; textureId?: string; uv?: CubeUvMode } = {}): ModelHandle {
        return this.library.createCube(opts);
    }

    createSphere(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        return this.library.createSphere(opts);
    }

    createCylinder(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        return this.library.createCylinder(opts);
    }

    createCone(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        return this.library.createCone(opts);
    }

    /** Create a textured quad (plane) centered at the origin on the XY plane. */
    createPlane(opts: { width?: number; height?: number; textureId?: string } = {}): ModelHandle {
        return this.library.createPlane(opts);
    }

    /** Register a model from raw geometry data. Returns a handle for `instances.add`. */
    loadModel(data: ModelData): ModelHandle {
        return this.library.loadModel(data);
    }

    /** Load a glTF/GLB model from a URL. */
    loadGltf(url: string, opts?: { animations?: string[] }): Promise<GltfModel> {
        return this.library.loadGltf(url, opts);
    }

    /** Upload a previously-parsed glTF to the GPU. */
    uploadParsedGltf(parsed: ParsedGltf): GltfModel {
        return this.library.uploadParsedGltf(parsed);
    }

    /**
     * Upload every prefab in the bucket to the GPU and stash the handle on
     * each prefab so `bucket.get(id)` resolves to a usable model. Also
     * subscribes the resync coordinator to the bucket's `clips-changed`
     * channel for lazy load/unload.
     */
    async upload(assets: AssetBucket<'3d', any, any>): Promise<void> {
        const bucket = assets.prefabs as unknown as PrefabBucket3D;
        this.animation.attachBucket(bucket);

        // Upload textures from the asset's texture bucket
        // Must await all texture uploads so createPlane() finds them in gpuTextures.
        const texturePromises: Promise<void>[] = [];
        for (const prefab of assets.textures.entries()) {
            if (prefab.type === 'texture') {
                texturePromises.push(this.core.textures.upload(prefab as TexturePrefab));
            }
        }
        await Promise.all(texturePromises);

        for (const prefab of bucket.entries()) {
            if (prefab.type === 'gltf') {
                const beforeSkinCount = this.core.models.skinnedModelCount();
                const model = this.uploadParsedGltf(prefab.parsed);
                setPrefabHandle(prefab, model);
                if (this.core.models.skinnedModelCount() > beforeSkinCount) {
                    this.animation.registerSkin(prefab.id, beforeSkinCount);
                }
            } else if (prefab.type === 'grid') {
                const model = this.createGrid({
                    size: prefab.size,
                    step: prefab.step,
                    lineWidth: prefab.lineWidth,
                });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cube') {
                const cube = prefab as unknown as CubePrefab;
                const model = this.createCube({ size: cube.size, textureId: (cube as any).texture, uv: cube.uv });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'plane') {
                const plane = prefab as PlanePrefab;
                const model = this.createPlane({
                    width: plane.width,
                    height: plane.height,
                    textureId: plane.texture,
                });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'sphere') {
                const sphere = prefab as unknown as SpherePrefab;
                const model = this.createSphere({ segments: sphere.segments, textureId: (sphere as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cylinder') {
                const cyl = prefab as unknown as CylinderPrefab;
                const model = this.createCylinder({ segments: cyl.segments, textureId: (cyl as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cone') {
                const cone = prefab as unknown as ConePrefab;
                const model = this.createCone({ segments: cone.segments, textureId: (cone as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'mesh') {
                const meshPrefab = prefab as unknown as MeshPrefab;
                const model = this.library.createMesh({
                    positions: meshPrefab.positions,
                    normals: meshPrefab.normals,
                    uvs: meshPrefab.uvs,
                    indices: meshPrefab.indices,
                    textureId: (meshPrefab as any).texture,
                });
                setPrefabHandle(prefab, model);
            }
        }
    }
}

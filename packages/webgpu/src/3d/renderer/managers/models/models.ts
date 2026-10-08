import type { CubeUvMode, ParsedGltf } from 'murow/renderer';
import type { GltfModel, ModelData, ModelHandle } from '../../types';
import type { ModelLibrary } from '../../internals/model-library';

/**
 * ModelsManager is the public facade for creating and loading GPU meshes. It
 * wraps `ModelLibrary`; the returned `ModelHandle` is passed to
 * `renderer.instances.add`.
 */
export class ModelsManager {
    constructor(private readonly library: ModelLibrary) {}

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
}

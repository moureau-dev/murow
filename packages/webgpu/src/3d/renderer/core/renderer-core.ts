import type { TgpuRoot } from 'typegpu';
import { MESH_UNIFORM_FLOATS } from '../../../core/types';
import type { MeshPipelines } from '../internals/mesh-pipelines';
import type { ModelLibrary } from '../internals/model-library';
import type { TextureRegistry } from '../internals/texture-registry';
import type { MaterialLibrary } from '../managers/materials';
import { Frustum } from '../internals/frustum';

/**
 * RendererCore holds the shared GPU resources and frame state that every
 * manager and the composition root read. It carries no peer managers, so it
 * cannot become a service locator.
 */
export class RendererCore {
    root!: TgpuRoot;
    device!: GPUDevice;
    context!: GPUCanvasContext;
    format!: GPUTextureFormat;
    pipelines!: MeshPipelines;
    models!: ModelLibrary;
    textures!: TextureRegistry;
    materialLibrary!: MaterialLibrary;

    /** Camera frustum, extracted from the view-projection each frame. */
    readonly frustum = new Frustum();

    /** Shared uniform block written once per frame. */
    readonly uniformData = new Float32Array(MESH_UNIFORM_FLOATS);

    /** Render target size in physical pixels. */
    width = 1;
    height = 1;
}

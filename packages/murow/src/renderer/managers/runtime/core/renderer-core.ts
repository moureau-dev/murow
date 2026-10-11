import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';

import { MESH_UNIFORM_FLOATS } from '../engine-core/types';
import type { MeshPipelines } from '../internals/mesh-pipelines';
import type { ModelLibrary } from '../internals/model-library';
import type { TextureRegistry } from '../internals/texture-registry';
import type { MaterialLibrary } from '../materials';
import { Frustum } from '../internals/frustum';
import type { SceneUniforms } from './scene';

/**
 * RendererCore holds the shared GPU resources and frame state that every
 * manager and the composition root read. It carries no peer managers, so it
 * cannot become a service locator.
 */
export class RendererCore {
    root!: { device: RawDevice };
    device!: RawDevice;
    context!: RawCanvasContext;
    format!: RawTextureFormat;
    pipelines!: MeshPipelines;
    models!: ModelLibrary;
    textures!: TextureRegistry;
    materialLibrary!: MaterialLibrary;

    /** Camera frustum, extracted from the view-projection each frame. */
    readonly frustum = new Frustum();

    /** Shared uniform block written once per frame. */
    readonly uniformData = new Float32Array(MESH_UNIFORM_FLOATS);

    /** Writes and uploads the shared per-frame uniforms. */
    scene!: SceneUniforms;

    /** Render target size in physical pixels. */
    width = 1;
    height = 1;
}

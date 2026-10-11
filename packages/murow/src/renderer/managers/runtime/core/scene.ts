import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';

import {
    MESH_UNIFORM_ALPHA_OFFSET,
    MESH_UNIFORM_CAMERA_OFFSET,
    MESH_UNIFORM_TIME_OFFSET,
    MESH_UNIFORM_RESOLUTION_OFFSET,
} from '../engine-core/types';

/** Values written into the shared per-frame uniform block. */
export interface SceneUniformValues {
    readonly vpMatrix: Float32Array;
    readonly alpha: number;
    readonly time: number;
    readonly cameraPos: readonly [number, number, number];
    readonly width: number;
    readonly height: number;
}

/**
 * Owns the shared per-frame uniform block: view-projection, alpha, camera
 * position, time and render resolution. The light block occupies the same block
 * and is written by the light manager before `write`, which uploads the result.
 */
export class SceneUniforms {
    constructor(
        private readonly device: RawDevice,
        private readonly buffer: RawBuffer,
        private readonly data: Float32Array,
    ) {}

    /** Fill and upload the shared uniforms. */
    write(values: SceneUniformValues): void {
        const data = this.data;
        data.set(values.vpMatrix, 0);
        data[MESH_UNIFORM_ALPHA_OFFSET] = values.alpha;
        const camera = values.cameraPos;
        data[MESH_UNIFORM_CAMERA_OFFSET] = camera[0];
        data[MESH_UNIFORM_CAMERA_OFFSET + 1] = camera[1];
        data[MESH_UNIFORM_CAMERA_OFFSET + 2] = camera[2];
        data[MESH_UNIFORM_TIME_OFFSET] = values.time;
        data[MESH_UNIFORM_RESOLUTION_OFFSET] = values.width;
        data[MESH_UNIFORM_RESOLUTION_OFFSET + 1] = values.height;
        this.device.queue.writeBuffer(this.buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    }
}

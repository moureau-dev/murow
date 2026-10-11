/**
 * The WebGPU implementation of the renderer's runtime ports.
 *
 * `murow/renderer`'s managers depend only on the `RendererRuntime` interface;
 * this builds the concrete object (device + presenter + WSGL compile + raw
 * resource factories + compute) and hands it in. No globals.
 */
import type { Presentation, RendererRuntime } from 'murow/renderer/managers';
import { compileProgram } from './gpu/backend';
import { createGpuBindGroupLayout, createRawBuffer } from './gpu/device';
import { ComputeBuilder } from './compute/compute-builder';
import { ComputeManager } from './compute/compute-manager';
import { buildAnimationKernel, uploadPackedToKernel } from './3d/skeletal-animation-compute/kernel';
import { packAnimationData } from './3d/skeletal-animation-compute/packer';
import { CAMERA_EFFECT_WGSL, HITBOX_WGSL, SPRITE_2D_WGSL } from './renderer-shaders';

const SHADER_SOURCES: Record<string, string> = {
    cameraEffect: CAMERA_EFFECT_WGSL,
    hitbox: HITBOX_WGSL,
    sprite2d: SPRITE_2D_WGSL,
};

/** Build the WebGPU runtime the renderer drives. */
export function webgpuRuntime(): RendererRuntime {
    const runtime: RendererRuntime = {
        presentation: undefined as unknown as Presentation,

        async createPresentation(canvas: HTMLCanvasElement): Promise<Presentation> {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error('murow/webgpu: no GPU adapter available');
            const limits = adapter.limits;
            const device = await adapter.requestDevice({
                requiredLimits: {
                    maxBufferSize: limits.maxBufferSize,
                    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
                    maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
                    maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
                    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
                },
            });
            const context = canvas.getContext('webgpu');
            if (!context) throw new Error('murow/webgpu: canvas has no webgpu context');
            const format = navigator.gpu.getPreferredCanvasFormat();
            const presentation: Presentation = {
                device: device as never,
                format,
                context: context as never,
                configure: (descriptor) => context.configure({ device, format, alphaMode: (descriptor.alphaMode ?? 'opaque') as never }),
                getCurrentTexture: () => context.getCurrentTexture() as unknown as { createView(): import('murow/gpu').RawTextureView },
            };
            runtime.presentation = presentation;
            return presentation;
        },

        compile: (shaders) => compileProgram(shaders as never),
        createRawBuffer: (schema, usage) => createRawBuffer(runtime.presentation.device as never, schema as never, usage as never),
        createBindGroupLayout: (descriptor) => createGpuBindGroupLayout(runtime.presentation.device as never, descriptor as never) as never,
        shaderSource: (name) => SHADER_SOURCES[name] ?? '',

        compute: {
            ComputeBuilder: ComputeBuilder as never,
            ComputeManager: ComputeManager as never,
            buildAnimationKernel,
            uploadPackedToKernel,
            packAnimationData,
        },
    };
    return runtime;
}


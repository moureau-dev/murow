/**
 * WebGPU implementation of the renderer's backend ports.
 *
 * Installs the concrete WebGPU pieces (`compile`, raw buffer/bind-group-layout
 * factories, compute, presentation) into the backend-agnostic renderer
 * (`murow/renderer`). A different backend would install its own; the renderer
 * itself contains no WebGPU.
 */
import {
    configureComputeProvider,
    configurePresentationFactory,
    configureRendererBackend,
} from 'murow/renderer/managers';
import { compileProgram } from './gpu/backend';
import { createGpuBindGroupLayout, createRawBuffer } from './gpu/device';
import { ComputeBuilder } from './compute/compute-builder';
import { ComputeManager } from './compute/compute-manager';
import { buildAnimationKernel, uploadPackedToKernel } from './3d/skeletal-animation-compute/kernel';
import { packAnimationData } from './3d/skeletal-animation-compute/packer';
import './renderer-shaders';

let installed = false;

/** Install the WebGPU implementation of every renderer port. Idempotent. */
export function installWebGPUBackend(): void {
    if (installed) return;
    installed = true;

    configureRendererBackend({
        compile: (shaders) => compileProgram(shaders as never),
        createRawBuffer: (device, schema, usage) => createRawBuffer(device as never, schema as never, usage as never),
        createBindGroupLayout: (device, descriptor) => createGpuBindGroupLayout(device as never, descriptor as never) as never,
    });

    configureComputeProvider({
        ComputeBuilder: ComputeBuilder as never,
        ComputeManager: ComputeManager as never,
        buildAnimationKernel,
        uploadPackedToKernel,
        packAnimationData,
    });

    configurePresentationFactory((async (canvas) => {
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
        return {
            device: device as never,
            format,
            context: context as never,
            configure: (descriptor) => context.configure({ device, format, alphaMode: (descriptor.alphaMode ?? 'opaque') as never }),
            getCurrentTexture: () => context.getCurrentTexture(),
        };
    }) as never);
}

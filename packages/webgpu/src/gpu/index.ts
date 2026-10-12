/**
 * WebGPU's implementation of the `murow/gpu` target seam.
 *
 * `murow/gpu` is target-agnostic. This module supplies the WGSL syntax and
 * backend (`backend/`), the WGSL helper source, and the WebGPU device and
 * context. The `d` and `std` namespaces come from `murow/gpu/dsl`.
 */
export * from './syntax';
export * from './backend';
export * from './device';

// The authoring namespaces, re-exported so the shim import sites keep working.
import { d as gpuD, std as gpuStd } from 'murow/gpu/dsl';

// Single local copies. Shader bodies are parsed from their source, so the
// `d`/`std` identifiers they reference must not be renamed by a bundler.
// Declaring one copy here and importing it everywhere keeps the names stable.
export const d: typeof gpuD = { ...gpuD };
export const std: typeof gpuStd = { ...gpuStd };

export { typeOf, alignOf, sizeOf, typeSize, typeAlign, alignUp } from 'murow/gpu/dsl';

// The class-based `murow/gpu` surface, re-exported for the renderer.
export {
    GpuBackend,
    GpuContext,
    GpuShader,
    GpuProgram,
    GpuBindGroupLayout,
    GpuBindGroup,
    GpuBuffer,
    type GpuBackendSpec,
} from 'murow/gpu';

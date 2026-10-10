/**
 * WebGPU's implementation of the `murow/gpu` target seam.
 *
 * `murow/gpu` is target-agnostic. This module supplies the WGSL syntax and
 * backend (`backend/`), the WGSL helper source, and the WebGPU device and
 * context. The `d` and `std` namespaces come from `murow/gpu/dsl`.
 */
export * from './syntax';
export * from './backend';
export * from './helpers';
export * from './device';

// The authoring namespaces, re-exported so the shim import sites keep working.
export { d, std, typeOf, alignOf, sizeOf, typeSize, typeAlign, alignUp, typedD, typedStd } from 'murow/gpu/dsl';

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

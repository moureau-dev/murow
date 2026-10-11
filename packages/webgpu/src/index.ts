/**
 * @murow/webgpu — WebGPU backend for murow.
 *
 * The renderer and its managers are backend-agnostic and live in
 * `murow/renderer/managers/runtime`; this package supplies the WebGPU
 * implementation of the runtime ports plus the WebGPU-specific pieces (GPU
 * helpers, compute).
 */
export { d, std } from './gpu';

// The backend-agnostic surface, re-exported for convenience.

// The WebGPU renderer (composes the runtime managers).
export * from './runtime';
export { webgpuRuntime } from './webgpu-runtime';

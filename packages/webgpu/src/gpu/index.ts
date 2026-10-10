/**
 * WebGPU's implementation of the `murow/gpu` target seam.
 *
 * `murow/gpu` is target-agnostic. This module supplies the WGSL syntax and the
 * WGSL backend used by the renderer (and any other WebGPU code) to compile
 * `murow/gpu` IR.
 */
export * from './wgsl-syntax';
export * from './wgsl-backend';
export * from './data';
export * from './std';
export * from './environment';
export * from './helpers';
export * from './root';
export * from './tgpu';

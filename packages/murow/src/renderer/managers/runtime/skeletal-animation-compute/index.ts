import type { RendererRuntime } from '../backend';
export type AnimationKernelBudgets = any;

export function buildAnimationKernel(runtime: RendererRuntime, ...args: any[]): any {
    return runtime.compute.buildAnimationKernel(...args);
}

export function uploadPackedToKernel(runtime: RendererRuntime, ...args: any[]): any {
    return runtime.compute.uploadPackedToKernel(...args);
}

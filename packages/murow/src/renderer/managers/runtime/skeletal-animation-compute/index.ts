import { getComputeProvider } from '../backend';

export type AnimationKernelBudgets = any;

export function buildAnimationKernel(...args: any[]): any {
    return getComputeProvider().buildAnimationKernel(...args);
}

export function uploadPackedToKernel(...args: any[]): any {
    return getComputeProvider().uploadPackedToKernel(...args);
}

import type { RendererRuntime } from '../backend';
export function packAnimationData(runtime: RendererRuntime, ...args: any[]): any {
    return runtime.compute.packAnimationData(...args);
}

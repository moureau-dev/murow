/**
 * Renderer backend seam.
 *
 * A renderer's managers never talk to a concrete GPU API. They receive a
 * {@link GpuContext}, which already pairs a configured code generator with a
 * backend device, and compile their shaders and allocate resources through it.
 * Swapping WebGPU for another backend is therefore a matter of supplying a
 * different context.
 *
 * Pure types plus a small holder. No device.
 */
import type { GpuContext, GpuCapabilities } from '../../gpu';

/** A GPU backend a renderer drives, as seen by its managers. */
export interface RendererBackend {
    /** Code generator and device, paired and backend-agnostic. */
    readonly context: GpuContext;
    /** Feature flags of the underlying backend. */
    readonly capabilities: GpuCapabilities;
}

/** Wrap a context as a renderer backend. */
export function rendererBackend(context: GpuContext): RendererBackend {
    return { context, capabilities: context.backend.capabilities };
}

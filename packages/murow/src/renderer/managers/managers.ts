/**
 * Renderer managers composition root.
 *
 * Constructs a renderer's managers (instances, materials, lights, shadows,
 * decals, particles, camera) against a single {@link RendererBackend}. Because
 * the backend is a {@link GpuContext}, the same managers run on any GPU API;
 * capability flags let it pick fallbacks where a backend lacks a feature (for
 * example a compute-based skeletal animation on WebGPU versus a vertex path
 * elsewhere).
 *
 * The individual managers are ported onto this root incrementally; this class
 * owns the backend they all share.
 */
import type { GpuCapabilities, GpuContext } from '../../gpu';
import type { RendererBackend } from './backend';

/** Options for {@link RendererManagers}. */
export interface RendererManagersOptions {
    /** The GPU backend every manager is built against. */
    readonly backend: RendererBackend;
    /** Instance capacity hint, used to size buffers. */
    readonly maxInstances?: number;
    /** Light capacity hint, used to size buffers. */
    readonly maxLights?: number;
}

/** The managers a renderer drives, all bound to one backend. */
export class RendererManagers {
    /** The backend every manager was built against. */
    readonly backend: RendererBackend;

    constructor(options: RendererManagersOptions) {
        this.backend = options.backend;
    }

    /** Code generator and device the managers use. */
    get context(): GpuContext {
        return this.backend.context;
    }

    /** Feature flags of the underlying backend. */
    get capabilities(): GpuCapabilities {
        return this.backend.capabilities;
    }

    /** Release every resource owned by the managers. */
    destroy(): void {
        this.backend.context.destroy();
    }
}

import type { TgpuRoot } from 'typegpu';
import { ComputeBuilder, type ComputeOptions } from './compute-builder';

/**
 * ComputeManager is the public facade for creating GPU compute kernel builders.
 * Shared by the 2D and 3D renderers; construct with the renderer's `root`.
 */
export class ComputeManager {
    constructor(private readonly root: TgpuRoot) {}

    /** Create a GPU compute kernel builder. */
    create(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.root);
    }
}

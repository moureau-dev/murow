import { ComputeBuilder, type ComputeOptions } from '../../../../compute/compute-builder';
import type { Renderer2DCore } from '../../core';

/**
 * ComputeManager is the public facade for creating GPU compute builders. It
 * wraps `ComputeBuilder`.
 */
export class ComputeManager {
    constructor(private readonly core: Renderer2DCore) {}

    /** Create a GPU compute kernel builder. */
    create(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.core.root);
    }
}

import { ComputeBuilder, type ComputeOptions } from './compute-builder';

/**
 * ComputeManager is the public facade for creating GPU compute kernel builders.
 * Shared by the 2D and 3D renderers; construct with the renderer's device.
 */
export class ComputeManager {
    constructor(private readonly device: GPUDevice) {}

    /** Create a GPU compute kernel builder. */
    create(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.device);
    }
}

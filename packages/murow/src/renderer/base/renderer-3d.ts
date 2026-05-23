/**
 * Abstract base for 3D renderers. Defines the model/instance-based rendering API.
 */
import { BaseRenderer } from "./renderer";
import type { Camera3DState, Renderer3DOptions } from "../types";

export abstract class Base3DRenderer extends BaseRenderer<Renderer3DOptions> {
    readonly maxModels: number;

    abstract readonly camera: Camera3DState;

    constructor(canvas: HTMLCanvasElement, options: Renderer3DOptions) {
        super(canvas, options);
        // Subclasses are expected to fill `options.maxModels` (possibly by deriving
        // it from a prefab bucket) before calling super. Default to a generous slot
        // count so plain `new Renderer({ ... })` without a bucket still works.
        this.maxModels = options.maxModels ?? 32;
    }
}

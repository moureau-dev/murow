/**
 * Abstract base for 3D renderers. Defines the model/instance-based rendering API.
 */
import { BaseRenderer } from "./base-renderer";
import type { Camera3DState, Renderer3DOptions } from "./types";

export abstract class Base3DRenderer extends BaseRenderer<Renderer3DOptions> {
    readonly maxModels: number;

    abstract readonly camera: Camera3DState;

    constructor(canvas: HTMLCanvasElement, options: Renderer3DOptions) {
        super(canvas, options);
        this.maxModels = options.maxModels;
    }
}

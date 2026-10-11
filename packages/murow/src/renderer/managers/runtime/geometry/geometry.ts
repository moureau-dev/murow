import type { RendererRuntime } from '../backend';
import type { ClearColor } from 'murow/renderer';
import { GeometryBuilder, type GeometryOptions } from '../geometry-builder/geometry-builder';
import type { Renderer2DCore } from '../_2d/core';

/**
 * GeometryManager is the public facade for creating custom instanced 2D
 * geometries. It wraps `GeometryBuilder`.
 */
export class GeometryManager {
    constructor(
        private readonly core: Renderer2DCore,
        private readonly runtime: RendererRuntime,
        private readonly canvas: HTMLCanvasElement,
        private readonly getClearColor: () => ClearColor,
    ) {}

    /** Create a custom instanced geometry builder. */
    create(name: string, options: GeometryOptions): GeometryBuilder {
        return new GeometryBuilder(
            name, options,
            this.core.root, this.core.format, this.canvas, this.getClearColor(),
            this.runtime,
        );
    }
}

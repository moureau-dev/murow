/**
 * Constructs and wires the 2D renderer's managers against the shared core,
 * mirroring {@link RendererManagers} for 3D.
 *
 * The renderer instantiates this with its dependencies and then exposes each
 * manager as a property, so nothing backend-specific lives in the renderer.
 */
import type { Logger } from 'murow/core';
import type { PrefabBucket2D } from 'murow/renderer';
import { CameraManager2D, SpritesheetManager, SpriteManager, GeometryManager } from './runtime';
import type { Renderer2DCore } from './runtime';
import type { RendererRuntime } from './runtime/backend';

/** Dependencies the 2D managers need from the renderer. */
export interface RendererManagers2DDeps {
    core: Renderer2DCore;
    runtime: RendererRuntime;
    canvas: HTMLCanvasElement;
    logger: Logger;
    camera: CameraManager2D;
    maxSprites: number;
    prefabs: PrefabBucket2D | null;
    getClearColor(): [number, number, number, number];
}

/** The 2D renderer's managers, all bound to one core. */
export class RendererManagers2D {
    readonly camera: CameraManager2D;
    readonly sheets: SpritesheetManager;
    readonly sprites: SpriteManager;
    readonly geometry: GeometryManager;

    constructor(private readonly deps: RendererManagers2DDeps) {
        this.camera = deps.camera;
        this.sheets = new SpritesheetManager({ core: deps.core });
        this.sprites = new SpriteManager({
            core: deps.core,
            capacity: deps.maxSprites,
            logger: deps.logger,
            prefabs: deps.prefabs,
        });
        this.geometry = new GeometryManager({ 
            core: deps.core,
            runtime: deps.runtime,
            canvas: deps.canvas,
            getClearColor: deps.getClearColor,
        });
    }
}

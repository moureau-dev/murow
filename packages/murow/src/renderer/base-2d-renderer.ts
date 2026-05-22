/**
 * Abstract base for 2D renderers. Defines the sprite-based rendering API.
 */
import { BaseRenderer } from "./base-renderer";
import type {
    Camera2DState,
    Renderer2DOptions,
    SpriteHandle,
    SpriteOptions,
    SpritesheetHandle,
    SpritesheetSource,
} from "./types";

export abstract class Base2DRenderer extends BaseRenderer<Renderer2DOptions> {
    readonly maxSprites: number;

    abstract readonly camera: Camera2DState;

    constructor(canvas: HTMLCanvasElement, options: Renderer2DOptions) {
        super(canvas, options);
        // Subclasses are expected to fill `options.maxSprites` (possibly by deriving
        // it from a prefab bucket) before calling super.
        this.maxSprites = options.maxSprites ?? 1024;
    }

    abstract loadSpritesheet(source: SpritesheetSource): Promise<SpritesheetHandle>;
    abstract addSprite(options: SpriteOptions): SpriteHandle;
    abstract removeSprite(sprite: SpriteHandle): void;
}

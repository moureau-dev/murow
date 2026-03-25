import { lerp, World } from "../../../../packages/murow/src";
import { Shared } from "../shared";
import { Application, Graphics, Sprite, Texture } from "pixi.js";

const WIDTH = 1200;
const HEIGHT = 800;

/**
 * PixiRenderer handles rendering of entities using PixiJS.
 * It interpolates entity positions for smooth rendering.
 * It also manages sprite creation and cleanup.
 */
export class PixiRenderer {
    app: Application;
    sprites: Map<number, Sprite> = new Map();
    textures: Texture[] = [];

    // Interpolation state
    previousTransforms: Map<number, SpriteTransform> = new Map();

    constructor() {
        this.app = new Application();
    }

    async init() {
        await this.app.init({
            width: WIDTH,
            height: HEIGHT,
            backgroundColor: 0x1a1a2e,
        });
        document.body.appendChild(this.app.canvas);

        // Create simple colored textures (no external image files needed)
        this.textures.push(this.createCircleTexture(0x00ff00)); // Green
        this.textures.push(this.createCircleTexture(0xff0000)); // Red
    }

    createCircleTexture(color: number): Texture {
        const graphics = new Graphics();
        graphics.circle(16, 16, 16);
        graphics.fill({ color });
        return this.app.renderer.generateTexture(graphics);
    }

    /**
     * Store the previous state of all entities in the world.
     * For interpolation during rendering.
     *
     * @param world ECS world to store previous state from
     */
    storePreviousState(world: World) {
        for (const eid of world.query(Shared.Components.Position)) {
            const transform = world.get(eid, Shared.Components.Position);

            this.previousTransforms.set(eid, {
                x: transform.x,
                y: transform.y,
                opacity: 1,
                rotation: 0,
                scale: 1,
            });
        }
    }

    /**
     * Render the ECS world using PixiJS.
     * This runs every frame and interpolates entity positions
     * with the given alpha factor from the fixed ticker.
     *
     * @param world ECS world to render
     * @param alpha Interpolation factor between ticks
     */
    render(world: World, alpha: number) {
        for (const eid of world.query(
            Shared.Components.Position,
            Shared.Components.Sprite,
        )) {
            let sprite = this.sprites.get(eid);

            // Create sprite if it doesn't exist
            if (!sprite) {
                const spriteData = world.get(eid, Shared.Components.Sprite);
                sprite = new Sprite(this.textures[spriteData.textureId]);
                sprite.anchor.set(0.5);
                sprite.scale.set(spriteData.scale);
                this.app.stage.addChild(sprite);
                this.sprites.set(eid, sprite);
            }

            // Get current physics state
            const transform = world.get(eid, Shared.Components.Position);

            // Interpolate for smooth rendering
            const prev = this.previousTransforms.get(eid);
            if (prev) {
                sprite.x = lerp(prev.x, transform.x, alpha);
                sprite.y = lerp(prev.y, transform.y, alpha);
                sprite.rotation = lerp(prev.rotation, 0, alpha);
                sprite.scale = lerp(prev.scale, 0, alpha);
                sprite.alpha = lerp(prev.opacity, 0, alpha);
            } else {
                sprite.x = transform.x;
                sprite.y = transform.y;
            }
        }
    }

    /**
     * Clean up sprites for despawned entities.
     *
     * @param world ECS world to check for despawned entities
     */
    cleanup(world: World) {
        for (const [eid, sprite] of this.sprites) {
            if (!world.isAlive(eid)) {
                this.app.stage.removeChild(sprite);
                sprite.destroy();
                this.sprites.delete(eid);
                this.previousTransforms.delete(eid);
            }
        }
    }
}

interface SpriteTransform {
    x: number;
    y: number;
    opacity: number;
    rotation: number;
    scale: number;
}

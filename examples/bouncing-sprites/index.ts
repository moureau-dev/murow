import { Application, Graphics, Sprite, Texture } from 'pixi.js';
import {
  World,
  defineComponent,
  BinaryCodec,
  lerp,
  GameLoop,
} from 'murow';


namespace Components {
  export const Position = defineComponent('Position', {
    x: BinaryCodec.f32,
    y: BinaryCodec.f32,
  });

  export const Velocity = defineComponent('Velocity', {
    vx: BinaryCodec.f32,
    vy: BinaryCodec.f32,
  });

  export const Sprite = defineComponent('Sprite', {
    textureId: BinaryCodec.u8,
    scale: BinaryCodec.f32,
  });

  export const Health = defineComponent('Health', {
    value: BinaryCodec.f32,
  });
}

const WIDTH = 1200;
const HEIGHT = 800;

/**
 * PixiRenderer handles rendering of entities using PixiJS.
 * It interpolates entity positions for smooth rendering.
 * It also manages sprite creation and cleanup.
 */
class PixiRenderer {
  app: Application;
  sprites: Map<number, Sprite> = new Map();
  textures: Texture[] = [];

  // Interpolation state
  previousPositions: Map<number, { x: number; y: number; }> = new Map();

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
    for (const eid of world.query(Components.Position)) {
      const transform = world.get(eid, Components.Position);
      this.previousPositions.set(eid, {
        x: transform.x,
        y: transform.y,
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
    for (const eid of world.query(Components.Position, Components.Sprite)) {
      let sprite = this.sprites.get(eid);

      // Create sprite if it doesn't exist
      if (!sprite) {
        const spriteData = world.get(eid, Components.Sprite);
        sprite = new Sprite(this.textures[spriteData.textureId]);
        sprite.anchor.set(0.5);
        sprite.scale.set(spriteData.scale);
        this.app.stage.addChild(sprite);
        this.sprites.set(eid, sprite);
      }

      // Get current physics state
      const transform = world.get(eid, Components.Position);

      // Interpolate for smooth rendering
      const prev = this.previousPositions.get(eid);
      if (prev) {
        sprite.x = lerp(prev.x, transform.x, alpha);
        sprite.y = lerp(prev.y, transform.y, alpha);
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
    const despawned = world.getDespawned();
    for (const eid of despawned) {
      const sprite = this.sprites.get(eid)
      this.app.stage.removeChild(sprite);
      sprite.destroy();
      this.sprites.delete(eid);
      this.previousPositions.delete(eid);
    }
    world.flushDespawned();
  }
}

const AMOUNT_OF_ENTITIES = 60_000;

/**
 * Game class with ECS simulation calling pixi rendering.
 */
class Game extends GameLoop {
  world: World;
  renderer: PixiRenderer;

  constructor() {
    super({
      tickRate: 8,
      type: 'client',
      onRender: (_, alpha) => {
        this.renderer.render(this.world, alpha);
      },
    });

    const physicsTitle = document.querySelector("#info p[data-id='physics']");
    if (physicsTitle) {
      physicsTitle.textContent = physicsTitle.textContent.replace('%ticks%', this.options.tickRate.toString());
    }

    this.events.on('tick', ({ tick, deltaTime, input }) => {
      this.renderer.storePreviousState(this.world);
      this.world.runSystems(deltaTime);
      this.renderer.cleanup(this.world);

      if (tick % (this.options.tickRate * 2) === 0) {
        const fpsEl = document.querySelector("#fps");
        if (!fpsEl) return;

        fpsEl.textContent = `FPS: ${this.fps.toFixed(2)} | Entities: ${this.world.getEntityCount()}`;
      }

      // hold space to spawn more entities
      if (input.keys['Space']?.down) {
        this.spawnEntities();
      }
    });

    // Setup ECS world
    this.world = new World({
      maxEntities: AMOUNT_OF_ENTITIES * 2, // Extra buffer for entities that will spawn/despawn
      components: Object.values(Components),
    });

    // Setup Pixi renderer
    this.renderer = new PixiRenderer();

    // Register physics systems using ergonomic API
    this.setupSystems();

    // Spawn some entities after renderer is ready
    this.renderer.init().then(() => {
      this.spawnEntities();
      this.start();

      const fpsEl = document.querySelector("#fps");
      if (!fpsEl) return;
      fpsEl.textContent = `FPS: ${this.fps.toFixed(2)} | Entities: ${this.world.getEntityCount()}`;
    });
  }

  setupSystems() {
    // use this.input for systems that need input here

    // Movement system - updates position from velocity
    this.world
      .addSystem()
      .query(Components.Position, Components.Velocity)
      .fields([
        { transform: ['x', 'y'] },
        { velocity: ['vx', 'vy'] }
      ])
      .run((entity, deltaTime) => {
        entity.transform_x += entity.velocity_vx * deltaTime;
        entity.transform_y += entity.velocity_vy * deltaTime;
      });

    // Bounce system - inverts velocity when hitting bounds
    this.world
      .addSystem()
      .query(Components.Position, Components.Velocity)
      .fields([
        { transform: ['x', 'y'] },
        { velocity: ['vx', 'vy'] }
      ])
      .when((entity) => {
        return (
          entity.transform_x <= 0 ||
          entity.transform_x >= WIDTH ||
          entity.transform_y <= 0 ||
          entity.transform_y >= HEIGHT
        );
      })
      .run((entity) => {
        entity.velocity_vx *= -1;
        entity.velocity_vy *= -1;
      });

    // Health decay system
    this.world.addSystem()
      .query(Components.Health)
      .fields([{ health: ['value'] }])
      .run((entity, deltaTime) => {
        entity.health_value -= 5 * deltaTime;
      });

    // Despawn system
    this.world.addSystem()
      .query(Components.Health)
      .fields([{ health: ['value'] }])
      .when((entity) => entity.health_value <= 0)
      .run((entity) => {
        entity.despawn();
      });
  }

  spawnEntities() {
    // Spawn entities with random positions, velocities and sizes
    for (let i = 0; i < AMOUNT_OF_ENTITIES; i++) {
      const eid = this.world.spawn();

      this.world.entity(eid)
        .add(Components.Health, {
          value: 10 + Math.floor(Math.random() * 90),
        })
        .add(Components.Position, {
          x: Math.random() * WIDTH,
          y: Math.random() * HEIGHT,
        })
        .add(Components.Velocity, {
          vx: (Math.random() - 0.5) * 100,
          vy: (Math.random() - 0.5) * 100,
        })
        .add(Components.Sprite, {
          textureId: Math.random() > 0.5 ? 0 : 1,
          scale: 0.02 + Math.random() * 0.08,
        });
    }
  }
}

new Game();

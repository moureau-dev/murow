import {
    World,
    defineComponent,
    BinaryCodec,
    GameLoop,
    type SpriteHandle,
    type SpritesheetHandle,
} from 'murow';
import { WebGPU2DRenderer, ParticleEmitter } from 'murow/webgpu';

// --- Components ---

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
const AMOUNT_OF_ENTITIES = 60_000;


// --- Spritesheet helper ---

/**
 * Generate a 64x32 spritesheet with a green and red circle.
 * Returns a blob URL that loadSpritesheet can fetch.
 */
function createCircleSpritesheet(): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;

    // Green circle (frame 0)
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.arc(16, 16, 16, 0, Math.PI * 2);
    ctx.fill();

    // Red circle (frame 1)
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(48, 16, 16, 0, Math.PI * 2);
    ctx.fill();

    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            resolve(URL.createObjectURL(blob!));
        });
    });
}

// --- WebGPU Renderer wrapper ---

class WebGPUSpriteRenderer {
    gpu: WebGPU2DRenderer;
    handles: (SpriteHandle | null)[];
    sheet: SpritesheetHandle;
    particles: ParticleEmitter;

    constructor(canvas: HTMLCanvasElement, maxEntities: number) {
        this.handles = new Array(maxEntities).fill(null);
        this.gpu = new WebGPU2DRenderer(canvas, {
            maxSprites: (AMOUNT_OF_ENTITIES/12) + 5000, // extra for particles
            clearColor: [0.2, 0.05, 0.15, 1],
        });
    }

    async init() {
        await this.gpu.init();

        // Center camera on the play area
        this.gpu.camera.x = WIDTH / 2;
        this.gpu.camera.y = HEIGHT / 2;

        const sheetUrl = await createCircleSpritesheet();
        this.sheet = await this.gpu.loadSpritesheet({
            image: sheetUrl,
            frameWidth: 32,
            frameHeight: 32,
        });

        this.particles = new ParticleEmitter(this.gpu, {
            max: 5000,
            lifetime: { min: 0.5, max: 1.5 },
            speed: { min: 50, max: 200 },
            size: { min: 2, max: 6 },
            gravity: [0, -200],
            color: [1, 0.6, 0.1, 1],  // orange tint over the sprite
            direction: { min: -45+90, max: 45+90 },
            fadeOut: true,
            sheet: this.sheet,
            sprite: 1, // red circle — tinted orange
        });
    }

    render(world: World, alpha: number) {
        for (const eid of world.query(Components.Position, Components.Sprite)) {
            let handle = this.handles[eid];

            if (!handle) {
                const spriteData = world.get(eid, Components.Sprite);
                const pos = world.get(eid, Components.Position);
                handle = this.gpu.addSprite({
                    sheet: this.sheet,
                    sprite: spriteData.textureId,
                    x: pos.x,
                    y: pos.y,
                    scaleX: spriteData.scale * 32,
                    scaleY: spriteData.scale * 32,
                });
                this.handles[eid] = handle;
            }

            const pos = world.get(eid, Components.Position);
            handle.x = pos.x;
            handle.y = pos.y;
        }

        this.gpu.render(alpha);
    }

    cleanup(world: World) {
        // O(deaths) not O(maxEntities) — only iterate entities that actually died this tick
        const despawned = world.getDespawned();
        for (let i = 0; i < despawned.length; i++) {
            const eid = despawned[i];
            const handle = this.handles[eid];
            if (handle !== null) {
                this.gpu.removeSprite(handle);
                this.handles[eid] = null;
            }
        }
        world.flushDespawned();
    }
}

// --- Game ---

class Game extends GameLoop<'client'> {
    world: World;
    renderer: WebGPUSpriteRenderer;

    constructor() {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;

        super({
            tickRate: 10,
            type: 'client',
        });

        const physicsTitle = document.querySelector("#info p[data-id='physics']");
        if (physicsTitle) {
            physicsTitle.textContent = physicsTitle.textContent!.replace('%ticks%', this.options.tickRate.toString());
        }

        this.events.on('render', ({ alpha }) => {
            this.renderer.render(this.world, alpha);
        })

        const samples: { tick: number; fps: number; entities: number }[] = [];
        let tracking = false;

        this.events.on('tick', ({ tick, deltaTime, input }) => {
            this.renderer.gpu.storePreviousState();
            this.world.runSystems(deltaTime);
            this.renderer.cleanup(this.world);

            // Emit particles from bouncing entities
            if (this.renderer.particles) {
                if (input.mouse.left.down) {
                    this.renderer.particles.emit(
                        input.mouse.position.x,
                        HEIGHT - input.mouse.position.y, // flip Y: screen-space → world-space
                        50,
                    );
                }

                this.renderer.particles.update(deltaTime);
            }


            const entities = this.world.getEntityCount();

            if (tick % (this.options.tickRate * 2) === 0) {
                const fpsEl = document.querySelector('#fps');
                if (!fpsEl) return;
                fpsEl.textContent = `FPS: ${this.fps.toFixed(2)} | Entities: ${entities}`;
            }

            // Track from first spawn until all entities die
            if (entities > 0 && !tracking) tracking = true;
            if (tracking) {
                samples.push({ tick, fps: Math.round(this.fps), entities });
                if (entities === 0) {
                    tracking = false;
                    console.table(samples);
                    samples.length = 0;
                }
            }

            if (input.keys['Space']?.down) {
                this.spawnEntities();
            }
        });

        this.world = new World({
            maxEntities: AMOUNT_OF_ENTITIES * 2,
            components: Object.values(Components),
        });

        this.renderer = new WebGPUSpriteRenderer(canvas, AMOUNT_OF_ENTITIES * 2);

        this.setupSystems();

        this.renderer.init().then(() => {
            this.spawnEntities();
            this.start();

            const fpsEl = document.querySelector('#fps');
            if (fpsEl) {
                fpsEl.textContent = `FPS: ${this.fps.toFixed(2)} | Entities: ${this.world.getEntityCount()}`;
            }
        });
    }

    setupSystems() {
        // Movement
        this.world
            .addSystem()
            .query(Components.Position, Components.Velocity)
            .fields([
                { transform: ['x', 'y'] },
                { velocity: ['vx', 'vy'] },
            ])
            .run((entity, deltaTime) => {
                entity.transform_x_array[entity.eid] += entity.velocity_vx_array[entity.eid] * deltaTime;
                entity.transform_y_array[entity.eid] += entity.velocity_vy_array[entity.eid] * deltaTime;
            });

        // Bounce
        this.world
            .addSystem()
            .query(Components.Position, Components.Velocity)
            .fields([
                { transform: ['x', 'y'] },
                { velocity: ['vx', 'vy'] },
            ])
            .when((entity) => {
                return (
                    entity.transform_x_array[entity.eid] <= 0 ||
                    entity.transform_x_array[entity.eid] >= WIDTH ||
                    entity.transform_y_array[entity.eid] <= 0 ||
                    entity.transform_y_array[entity.eid] >= HEIGHT
                );
            })
            .run((entity) => {
                entity.velocity_vx_array[entity.eid] *= -1;
                entity.velocity_vy_array[entity.eid] *= -1;
            });

        // Health decay
        this.world
            .addSystem()
            .query(Components.Health)
            .fields([{ health: ['value'] }])
            .run((entity, deltaTime) => {
                entity.health_value_array[entity.eid] -= 25 * deltaTime;
            });

        // Despawn
        this.world
            .addSystem()
            .query(Components.Health)
            .fields([{ health: ['value'] }])
            .when((entity) => entity.health_value_array[entity.eid] <= 0)
            .run((entity) => {
                entity.despawn();
            });
    }

    spawnEntities() {
        for (let i = 0; i < AMOUNT_OF_ENTITIES/12; i++) {
            const eid = this.world.spawn();
            this.world
                .entity(eid)
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

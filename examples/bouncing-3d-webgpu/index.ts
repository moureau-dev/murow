import {
    World,
    defineComponent,
    BinaryCodec,
    GameLoop,
    lerp,
    type InputSnapshot,
} from 'murow';
import { WebGPU3DRenderer, type MeshInstanceHandle } from 'murow/webgpu';

// --- Components ---

namespace Components {
    export const Position = defineComponent('Position', {
        x: BinaryCodec.f32,
        y: BinaryCodec.f32,
        z: BinaryCodec.f32,
    });

    export const Rotation = defineComponent('Rotation', {
        x: BinaryCodec.f32,
        y: BinaryCodec.f32,
        z: BinaryCodec.f32,
    });

    export const Scale = defineComponent('Scale', {
        x: BinaryCodec.f32,
        y: BinaryCodec.f32,
        z: BinaryCodec.f32,
    });

    export const Velocity = defineComponent('Velocity', {
        x: BinaryCodec.f32,
        y: BinaryCodec.f32,
        z: BinaryCodec.f32,
    });

    export const Model = defineComponent('Model', {
        modelId: BinaryCodec.u8,
    });

    export const Health = defineComponent('Health', {
        value: BinaryCodec.f32,
    });

    export const ScaleSpeed = defineComponent('ScaleSpeed', {
        value: BinaryCodec.f32,
    });
}

const WIDTH = 1200;
const HEIGHT = 800;
const DEPTH = 600;
const AMOUNT_OF_ENTITIES = 12_000;

// --- WebGPU 3D Renderer wrapper ---

class WebGPU3DWrapper {
    gpu: WebGPU3DRenderer;
    handles: (MeshInstanceHandle | null)[];

    constructor(canvas: HTMLCanvasElement, maxEntities: number) {
        this.handles = new Array(maxEntities).fill(null);
        this.gpu = new WebGPU3DRenderer(canvas, {
            maxModels: maxEntities,
            clearColor: [0.1, 0.1, 0.12, 1],
        });
    }

    async init() {
        await this.gpu.init();

        // Camera looking at center of the play area
        this.gpu.camera.position = [WIDTH * 0.5, HEIGHT * 0.5, 1200];
        this.gpu.camera.target = [WIDTH * 0.5, HEIGHT * 0.5, 0];
        this.gpu.camera.fov = 10;
        this.gpu.camera.near = 0.1;
        this.gpu.camera.far = 3000;

        // Load Suzanne from Khronos glTF samples
        const suzanneModel = await this.gpu.loadGltf(
            'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Suzanne/glTF/Suzanne.gltf',
        );

        return { suzanneModel };
    }

    render(world: World, alpha: number, models: any) {
        const modelHandles = [models.suzanneModel];

        for (const eid of world.query(Components.Position, Components.Scale, Components.Model)) {
            let handle = this.handles[eid];

            if (!handle) {
                const pos = world.get(eid, Components.Position);
                const rot = world.has(eid, Components.Rotation)
                    ? world.get(eid, Components.Rotation)
                    : { x: 0, y: 0, z: 0 };
                const scale = world.get(eid, Components.Scale);
                const modelData = world.get(eid, Components.Model);
                const model = modelHandles[modelData.modelId % modelHandles.length];

                const colors: [number, number, number][] = [
                    [1.0, 0.2, 0.2], // red cube
                    [0.2, 1.0, 0.2], // green sphere
                    [0.2, 0.2, 1.0], // blue suzanne
                ];

                handle = this.gpu.addInstance({
                    model,
                    x: pos.x, y: pos.y, z: pos.z,
                    rotX: rot.x, rotY: rot.y, rotZ: rot.z,
                    scaleX: scale.x, scaleY: scale.y, scaleZ: scale.z,
                    color: colors[modelData.modelId % colors.length],
                });
                this.handles[eid] = handle;
            }

            const pos = world.get(eid, Components.Position);
            const rot = world.has(eid, Components.Rotation)
                ? world.get(eid, Components.Rotation)
                : { x: 0, y: 0, z: 0 };
            const scale = world.get(eid, Components.Scale);

            handle.setPosition(pos.x, pos.y, pos.z);
            handle.setRotation(rot.x, rot.y, rot.z);
            handle.setScale(scale.x, scale.y, scale.z);
        }

        this.gpu.render(alpha);
    }

    cleanup(world: World) {
        const despawned = world.getDespawned();
        for (let i = 0; i < despawned.length; i++) {
            const eid = despawned[i];
            const handle = this.handles[eid];
            if (handle !== null) {
                this.gpu.removeInstance(handle);
                this.handles[eid] = null;
            }
        }
        world.flushDespawned();
    }
}

// --- Camera Controller ---

class CameraController {
    private dragging = false;
    private lastMouseX = 0;
    private lastMouseY = 0;

    constructor(
        private camera: import('murow/webgpu').Camera3D,
        private canvas: HTMLCanvasElement,
    ) {
        canvas.addEventListener('mousedown', (e) => {
            this.dragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        });
        canvas.addEventListener('mouseup', () => { this.dragging = false; });
        canvas.addEventListener('mouseleave', () => { this.dragging = false; });
        canvas.addEventListener('mousemove', (e) => {
            if (!this.dragging) return;
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.camera.orbit(-dx * 0.001, dy * 0.001);
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camera.zoom(-e.deltaY * 0.5);
        }, { passive: false });
    }

    update(input: InputSnapshot, deltaTime: number) {
        const speed = 500 * deltaTime;
        let right = 0, up = 0, forward = 0;

        if (input.keys['KeyW']?.down) forward += speed;
        if (input.keys['KeyS']?.down) forward -= speed;
        if (input.keys['KeyD']?.down) right += speed;
        if (input.keys['KeyA']?.down) right -= speed;
        if (input.keys['KeyQ']?.down) up += speed;
        if (input.keys['KeyE']?.down) up -= speed;
        if (right === 0 && up === 0 && forward === 0) return;

        this.camera.move(right, up, forward);
    }
}

// --- Game ---

class Game extends GameLoop<'client'> {
    world: World;
    renderer: WebGPU3DWrapper;
    models: any;
    camCtrl!: CameraController;

    constructor() {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;

        super({ tickRate: 15, type: 'client' });

        const physicsTitle = document.querySelector("#info p[data-id='physics']");
        if (physicsTitle) {
            physicsTitle.textContent = physicsTitle.textContent!.replace('%ticks%', this.options.tickRate.toString());
        }

        this.events.on('render', ({ alpha }) => {
            this.renderer.render(this.world, alpha, this.models);
        });

        this.events.on('pre-tick', () => {
            this.renderer.gpu.storePreviousState();
        });

        this.events.on('tick', ({ tick, deltaTime, input }) => {
            this.camCtrl?.update(input, deltaTime);
            this.world.runSystems(deltaTime);

            if (tick % (this.options.tickRate * 2) === 0) {
                const fpsEl = document.querySelector('#fps');
                if (!fpsEl) return;
                fpsEl.textContent = `FPS: ${this.fps.toFixed(2)} | Entities: ${this.world.getEntityCount()}`;
            }

            if (input.keys['Space']?.down) {
                this.spawnEntities();
            }
        });

        this.events.on('post-tick', () => {
          this.renderer.cleanup(this.world);
        })

        this.world = new World({
            maxEntities: AMOUNT_OF_ENTITIES * 2,
            components: Object.values(Components),
        });

        this.renderer = new WebGPU3DWrapper(canvas, AMOUNT_OF_ENTITIES * 2);

        this.setupSystems();

        this.renderer.init().then((models) => {
            this.models = models;
            this.camCtrl = new CameraController(this.renderer.gpu.camera, canvas);
            this.spawnEntities();
            this.start();

            const fpsEl = document.querySelector('#fps');
            if (fpsEl) {
                fpsEl.textContent = `FPS: ${this.fps.toFixed(2)} | Entities: ${this.world.getEntityCount()}`;
            }
        });
    }

    setupSystems() {
        // Movement + rotation animation
        this.world
            .addSystem()
            .query(Components.Position, Components.Velocity, Components.Rotation)
            .fields([
                { position: ['x', 'y', 'z'] },
                { velocity: ['x', 'y', 'z'] },
                { rotation: ['x', 'y', 'z'] },
            ])
            .run((entity, deltaTime) => {
                entity.position_x += entity.velocity_x * deltaTime;
                entity.position_y += entity.velocity_y * deltaTime;
                entity.position_z += entity.velocity_z * deltaTime;
                entity.rotation_x += deltaTime * 0.5;
                entity.rotation_y += deltaTime * 0.3;
            });

        // Bounce in 3D
        this.world
            .addSystem()
            .query(Components.Position, Components.Velocity)
            .fields([
                { position: ['x', 'y', 'z'] },
                { velocity: ['x', 'y', 'z'] },
            ])
            .when((entity) => {
                return (
                    entity.position_x <= 0 || entity.position_x >= WIDTH ||
                    entity.position_y <= 0 || entity.position_y >= HEIGHT ||
                    entity.position_z <= -DEPTH || entity.position_z >= DEPTH
                );
            })
            .run((entity) => {
                if (entity.position_x <= 0 || entity.position_x >= WIDTH) entity.velocity_x *= -1;
                if (entity.position_y <= 0 || entity.position_y >= HEIGHT) entity.velocity_y *= -1;
                if (entity.position_z <= -DEPTH || entity.position_z >= DEPTH) entity.velocity_z *= -1;
            });

        // Health decay
        this.world
            .addSystem()
            .query(Components.Health)
            .fields([{ health: ['value'] }])
            .run((entity, deltaTime) => {
                entity.health_value -= 10 * deltaTime;
            });

        // Rescaling (sine wave)
        this.world
            .addSystem()
            .query(Components.Scale, Components.ScaleSpeed)
            .fields([
                { scale: ['x', 'y', 'z'] },
                { factor: ['value'] },
            ])
            .run((entity, deltaTime) => {
                const speed = entity.factor_value * deltaTime * 0.15;
                const amplitude = 0.75;
                const elapsed = Date.now();
                const scaleAmount = Math.sin(elapsed * speed) * amplitude + 1.0;
                entity.scale_x = 10 * scaleAmount;
                entity.scale_y = 10 * scaleAmount;
                entity.scale_z = 10 * scaleAmount;
            });

        // Despawn
        this.world
            .addSystem()
            .query(Components.Health)
            .fields([{ health: ['value'] }])
            .when((entity) => entity.health_value <= 0)
            .run((entity) => {
                entity.despawn();
            });
    }

    spawnEntities() {
        for (let i = 0; i < AMOUNT_OF_ENTITIES; i++) {
            const eid = this.world.spawn();
            const scale = 5 + Math.random() * 5;

            this.world.entity(eid)
                .add(Components.Health, {
                    value: 10000 + Math.floor(Math.random() * 90),
                })
                .add(Components.Position, {
                    x: Math.random() * WIDTH,
                    y: Math.random() * HEIGHT,
                    z: (Math.random() - 0.5) * DEPTH * 2,
                })
                .add(Components.Rotation, {
                    x: Math.random() * Math.PI * 2,
                    y: Math.random() * Math.PI * 2,
                    z: Math.random() * Math.PI * 2,
                })
                .add(Components.Scale, { x: scale, y: scale, z: scale })
                .add(Components.ScaleSpeed, { value: Math.random() })
                .add(Components.Velocity, {
                    x: (Math.random() - 0.5) * 100,
                    y: (Math.random() - 0.5) * 100,
                    z: (Math.random() - 0.5) * 100,
                })
                .add(Components.Model, {
                    modelId: Math.floor(Math.random() * 3), // 0=cube, 1=sphere, 2=suzanne
                });
        }
    }
}

new Game();

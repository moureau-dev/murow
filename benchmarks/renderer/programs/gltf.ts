import { GameLoop, SimpleRNG } from 'murow';
import { GltfModel, InstanceHandle, WebGPU3DRenderer } from 'murow/webgpu';

import type { Control, ControlValues, Program, ProgramHandle } from '..';

const DEFAULT_FOV = 70;
const DEFAULT_NEAR = 0.01;
const DEFAULT_FAR = 12;
const DEFAULT_INSTANCES = 2000;

const controls: Control[] = [
    { kind: 'number', key: 'instances', label: 'Instances', min: 1, max: 12_000, step: 100, default: DEFAULT_INSTANCES, restart: true },
    { kind: 'number', key: 'fov', label: 'FOV', min: 10, max: 170, step: 1, default: DEFAULT_FOV },
    { kind: 'number', key: 'near', label: 'Near', min: 0.001, max: 5, step: 0.01, default: DEFAULT_NEAR },
    { kind: 'number', key: 'far', label: 'Far', min: 1, max: 1000, step: 1, default: DEFAULT_FAR },
];

interface Prefab {
    model: string;
    data: {
        speed?: number;
        scale: number;
        animations: string[];
    };
}

const prefabs: Prefab[] = [];

export const gltf: Program = {
    name: '3D glTF',
    controls,

    async init(canvas: HTMLCanvasElement, stats: HTMLElement, values: ControlValues): Promise<ProgramHandle> {
        const instances = Math.max(1, Math.floor(values.instances ?? DEFAULT_INSTANCES));
        const renderer = new WebGPU3DRenderer(canvas, {
          maxModels: prefabs.length + 10,
          clearColor: [0.15, 0.15, 0.2, 1],
          autoResize: true,
          maxSkinnedInstances: Math.max(12000, instances),
        });

        await renderer.init();

        const rng = new SimpleRNG(1212121);

        // Load models with animations
        const models = await Promise.all(prefabs.map(({ model, data }) =>
            renderer.loadGltf(model, { animations: data.animations })
        ));

        const playRandom = (prefab: typeof prefabs[number], instance: InstanceHandle, model: GltfModel) => {
            const next = (animationName?: string) => {
                const randomAnimation = rng.pick(prefab.data.animations as unknown as string[]);
                const name = rng.rand() > 0.5 ? animationName ?? randomAnimation : randomAnimation;

                try {
                    instance.play?.(name, {
                        loop: true,
                        speed: prefab?.data.speed,
                        crossfade: 0.15,
                        onEnd: () => next(animationName) // schedule next animation without growing call stack
                    });
                } catch (err) {
                    console.error(err);
                    console.error(`Available animations: `, model.animations)
                }
            };

            next();
        };

        for (let i = 0; i < instances; i++) {
            const index = rng.int(0, prefabs.length - 1);
            const model = models[index];
            const prefab = prefabs.find(({ model: m }) => m === model.src);
            if (!prefab) continue;

            const instance = renderer.addInstance({
                model,
                x: rng.rand() * 20,
                y: 0,
                z: rng.rand() * 20,
                scaleX: prefab.data.scale,
                scaleY: prefab.data.scale,
                scaleZ: prefab.data.scale,
            });

            playRandom(prefab, instance, model);
        }

        // Grid floor
        const gridModel = renderer.createGrid({
            size: 20,
            step: 0.33,
            lineWidth: 0.001,
        });

        renderer.addInstance({ model: gridModel, color: [0.25, 0.25, 0.3] });

        // FPS/Fly camera
        renderer.camera.movement = 'local';
        renderer.camera.setPosition(3, 0.5, 3);
        renderer.camera.setTarget(3, 0.5, 2);
        renderer.camera.fov = values.fov ?? DEFAULT_FOV;
        renderer.camera.near = values.near ?? DEFAULT_NEAR;
        renderer.camera.far = values.far ?? DEFAULT_FAR;

        // Pointer lock for FPS mouse look
        let locked = false;

        canvas.addEventListener('click', () => {
            if (!locked && typeof canvas.requestPointerLock === 'function') {
                canvas.requestPointerLock();
            }
        });
        document.addEventListener('pointerlockchange', () => {
            locked = document.pointerLockElement === canvas;
        });

        const loop = new GameLoop({ tickRate: 15, type: 'client' });

        let yaw = Math.PI; // looking toward -Z
        let pitch = 0;
        const LOOK_SENSITIVITY = 0.002;
        const MOVE_SPEED = 1.5;

        // prepare GPU lerp
        loop.events.on('pre-tick', () => {
            renderer.storePreviousState();
        });

        // Display and update stats every second
        loop.events.on('tick', ({ tick }) => {
            if (tick % loop.ticker.rate !== 0) return;

            const totalVertexCount = models.reduce((acc, curr) => acc + curr.totalVertexCount, 0);
            stats.textContent = `FPS: ${loop.fps} | Vertices: ${totalVertexCount} | Instantiations: ${instances} (${instances * totalVertexCount} vertexes)`;
        });

        // camera mouselook — desktop uses pointer lock for unbounded motion;
        // on touch devices (where lock isn't available) we drive the camera
        // while the primary pointer is held down.
        loop.events.on('tick', ({ input }) => {
            const driveLook = locked || input.mouse.left.down;
            if (driveLook) {
                yaw -= input.mouse.delta.position.x * LOOK_SENSITIVITY;
                pitch -= input.mouse.delta.position.y * LOOK_SENSITIVITY;
                pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
            }

            // target from yaw/pitch
            const pos = renderer.camera.position;
            const lookX = Math.sin(yaw) * Math.cos(pitch);
            const lookY = Math.sin(pitch);
            const lookZ = Math.cos(yaw) * Math.cos(pitch);
            renderer.camera.setTarget(pos[0] + lookX, pos[1] + lookY, pos[2] + lookZ);
        });

        // camera WASD movement
        loop.events.on('tick', ({ input, deltaTime }) => {
            const speed = MOVE_SPEED * deltaTime;
            let forward = 0, right = 0, up = 0;

            if (input.keys['KeyW']?.down) forward += speed;
            if (input.keys['KeyS']?.down) forward -= speed;
            if (input.keys['KeyD']?.down) right += speed;
            if (input.keys['KeyA']?.down) right -= speed;
            if (input.keys['Space']?.down) up += speed;
            if (input.keys['ShiftLeft']?.down) up -= speed;

            if (forward !== 0 || right !== 0 || up !== 0) {
                renderer.camera.move(right, up, forward);
            }
        });


        loop.events.on('render', ({ alpha }) => {
            renderer.render(alpha);
        });

        loop.start();

        return {
            onControlChange(key, value) {
                if (key === 'fov') renderer.camera.fov = value;
                else if (key === 'near') renderer.camera.near = value;
                else if (key === 'far') renderer.camera.far = value;
            },
            destroy() {
                loop.stop();
                renderer.destroy();
            },
        };
    },
};

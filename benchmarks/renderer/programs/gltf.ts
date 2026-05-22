import { GameLoop, SimpleRNG } from 'murow';
import { InstanceHandle, WebGPU3DRenderer, createPrefabBucket, type GltfPrefab, type PrefabBucket3D } from 'murow/webgpu';

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

interface PrefabConfig {
    id: PrefabId;
    url: string;
    speed?: number;
    scale: number;
    animations: string[];
}

type PrefabId = ''

const prefabConfigs: PrefabConfig[] = [];

export const gltf: Program = {
    name: '3D glTF',
    controls,

    async init(canvas: HTMLCanvasElement, stats: HTMLElement, values: ControlValues): Promise<ProgramHandle> {
        const instances = Math.max(1, Math.floor(values.instances ?? DEFAULT_INSTANCES));

        // Declare all prefabs upfront. Load fetches + parses everything in parallel.
        // Cast pins the typed-id union (`bucket.get` would otherwise be `never`-typed
        // because the loop hides literals from the compiler).
        const bucket = createPrefabBucket('3d') as PrefabBucket3D<PrefabId>;
        for (const cfg of prefabConfigs) {
            bucket.add({ type: 'gltf', id: cfg.id, url: cfg.url, animations: cfg.animations });
        }
        bucket.add({ type: 'grid', id: 'floor', size: 20, step: 0.33, lineWidth: 0.001 });
        await bucket.load();

        // Renderer self-sizes from the bucket: maxSkinnedInstances = instances * maxSkinnedPartsPerPrefab,
        // maxBonesPerSkin = max jointCount across prefabs. No more magic numbers.
        const renderer = new WebGPU3DRenderer(canvas, {
            maxModels: prefabConfigs.length + 10,
            clearColor: [0.15, 0.15, 0.2, 1],
            autoResize: true,
            prefabs: bucket,
            maxInstances: instances,
        });

        await renderer.init();

        const rng = new SimpleRNG(1212121);

        const playRandom = (cfg: PrefabConfig, instance: InstanceHandle, prefab: GltfPrefab) => {
            const next = (animationName?: string) => {
                const randomAnimation = rng.pick(cfg.animations);
                const name = rng.rand() > 0.5 ? animationName ?? randomAnimation : randomAnimation;

                try {
                    instance.play?.(name, {
                        loop: true,
                        speed: cfg.speed,
                        crossfade: 0.15,
                        onEnd: () => next(animationName) // schedule next animation without growing call stack
                    });
                } catch (err) {
                    console.error(err);
                    console.error(`Available animations: `, prefab.animations);
                }
            };

            next();
        };

        for (let i = 0; i < instances; i++) {
            const cfg = rng.pick(prefabConfigs);
            const prefab = bucket.get(cfg.id) as GltfPrefab;

            const instance = renderer.addInstance({
                model: prefab,
                x: rng.rand() * 20,
                y: 0,
                z: rng.rand() * 20,
                scaleX: cfg.scale,
                scaleY: cfg.scale,
                scaleZ: cfg.scale,
            });

            playRandom(cfg, instance, prefab);
        }

        // Grid floor
        renderer.addInstance({ model: bucket.get('floor'), color: [0.25, 0.25, 0.3] });

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

            let totalVertexCount = 0;
            for (const cfg of prefabConfigs) {
                totalVertexCount += (bucket.get(cfg.id) as GltfPrefab).totalVertexCount;
            }
            stats.textContent = `FPS: ${loop.fps} | Vertices: ${totalVertexCount} | Instantiations: ${instances} (${instances * totalVertexCount} vertexes)`;
        });

        // camera mouselook
        loop.events.on('tick', ({ input }) => {
            const driveLook = locked || input.mouse.left.down;
            if (driveLook) {
                yaw -= input.mouse.delta.position.x * LOOK_SENSITIVITY;
                pitch -= input.mouse.delta.position.y * LOOK_SENSITIVITY;
                pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
            }

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

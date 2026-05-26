import { GameLoop, PrefabBucket, SimpleRNG, type GltfPrefab } from 'murow';
import { MouseLook } from 'murow/core/input';
import { InstanceHandle, WebGPU3DRenderer } from 'murow/webgpu';

import type { Control, ControlValues, Program, ProgramHandle } from '..';

const DEFAULT_FOV = 70;
const DEFAULT_NEAR = 0.01;
const DEFAULT_FAR = 12;
const DEFAULT_INSTANCES = 2000;
const DEFAULT_SKINNING_CULL = 15;

const controls: Control[] = [
    { kind: 'number', key: 'instances', label: 'Instances', min: 1, max: 12_000, step: 100, default: DEFAULT_INSTANCES, restart: true },
    { kind: 'number', key: 'fov', label: 'FOV', min: 10, max: 170, step: 1, default: DEFAULT_FOV },
    { kind: 'number', key: 'near', label: 'Near', min: 0.001, max: 5, step: 0.01, default: DEFAULT_NEAR },
    { kind: 'number', key: 'far', label: 'Far', min: 1, max: 1000, step: 1, default: DEFAULT_FAR },
    { kind: 'number', key: 'animationCullDistance', label: 'Anim Cull', min: 1, max: 1000, step: 1, default: DEFAULT_SKINNING_CULL },
];

const bucket = new PrefabBucket('3d')
  // .add({
  //    type: 'gltf',
  //    id: 'soldier',
  //    src: 'assets/soldier.glb',
  //    metadata: {
  //        scale: 0.01,
  //    },
  //    animations: ['Idle', 'Walking'],
  // })
  .add({
      type: 'gltf',
      id: 'model',
      src: 'https://raw.githubusercontent.com/8thwall/web/72556f9122f5b0e861f55748cc9a938a59691273/examples/aframe/animation-mixer/mixamo-animated-lowpoly.glb',
      metadata: { scale: 0.175 },
  })
  .add({
      type: 'grid',
      id: 'floor',
      size: 20,
      step: 0.33,
      lineWidth: 0.001,
  })
  .add({ type: 'cube', id: 'crate', size: 1, metadata: { hp: 10 } })
  .addGroup('campfire', [
    { type: 'cube', id: 'logs', size: 1 },                                          // -> bucket.get('campfire.logs')
    { type: 'cube', id: 'flame', size: 0.3, offset: { position: [0, 0.3, 0] } },    // -> bucket.get('campfire.flame')
    { type: 'cube', size: 0.5, offset: { position: [0, 0.8, 0] } },                 // -> bucket.get('campfire.<hex>')
  ]);


export const gltf: Program = {
    name: '3D glTF',
    controls,

    async init(canvas: HTMLCanvasElement, stats: HTMLElement, values: ControlValues): Promise<ProgramHandle> {
        const instances = Math.max(1, Math.floor(values.instances ?? DEFAULT_INSTANCES));

        await bucket.load();

        const renderer = new WebGPU3DRenderer(canvas, {
            clearColor: [0.15, 0.15, 0.2, 1],
            autoResize: true,
            prefabs: bucket,
            maxInstances: instances,
            animationCullDistance: values.animationCullDistance ?? DEFAULT_SKINNING_CULL,
        });

        await renderer.init();

        const rng = new SimpleRNG(1212121);

        const playRandom = (instance: InstanceHandle, prefab: GltfPrefab) => {
            if (!prefab.animationList?.length) return;

            const list = prefab.animationList ?? [];
            if (!list.length) return;

            const next = (animationName?: string) => {
                const randomAnimation = rng.pick([...list]);
                const name = rng.rand() > 0.5 ? animationName ?? randomAnimation : randomAnimation;

                try {
                    instance.play?.(name, {
                        loop: true,
                        crossfade: 0.15,
                        onEnd: () => next(animationName) // schedule next animation without growing call stack
                    });
                } catch (err) {
                    console.error(err);
                    console.error(`Available animations: `, list);
                }
            };

            next();
        };

        const gltfPrefabs = bucket.getAllByType('gltf');
        const instancesHandlers: ReturnType<typeof renderer.addInstance>[] = [];

        const trySpawnRandom = () => {
              const forbidden = instancesHandlers.length >= renderer.maxSkinned
              if (forbidden) return;

              const prefab = rng.pick(gltfPrefabs);
              if (!prefab) return;

              const scale = (prefab.metadata.scale as number | undefined) ?? 1;

              const instance = renderer.addInstance({
                  model: prefab,
                  position: [rng.rand() * 20, 0, rng.rand() * 20],
                  scale,
              });

              instancesHandlers.push(instance);

              playRandom(instance, prefab);
              return instance;
        }

        for (let i = 0; i < instances; i++) trySpawnRandom();

        // Grid floor
        renderer.addInstance({ model: bucket.get('floor'), color: [0.25, 0.25, 0.3] });

        // Big Black Cube
        instancesHandlers.push(renderer.addInstance({ model: bucket.get('crate'), color: [0.2, 0.1, 0.05] }));

        // Spawn the whole group as one logical instance
        instancesHandlers.push(renderer.addInstance({ model: bucket.get('campfire'), position: [10, 0, 5] }));

        // FPS/Fly camera
        renderer.camera.movement = 'local';
        renderer.camera.setPosition(3, 0.5, 3);
        renderer.camera.setTarget(3, 0.5, 2);
        renderer.camera.fov = values.fov ?? DEFAULT_FOV;
        renderer.camera.near = values.near ?? DEFAULT_NEAR;
        renderer.camera.far = values.far ?? DEFAULT_FAR;

        // FPS mouselook. `drag: true` keeps it working on touch / iOS
        // where Pointer Lock isn't supported -- the user can hold the
        // left button and drag to look around.
        const mouseLook = new MouseLook({
            sensitivity: 0.002,
            yaw: { initial: Math.PI }, // looking toward -Z
            drag: true,
        });

        canvas.addEventListener('click', () => {
            mouseLook.lock(canvas).catch(() => { /* drag-to-look fallback */ });
        });

        const loop = new GameLoop({ tickRate: 15, type: 'client' });

        const MOVE_SPEED = 1.5;

        // prepare GPU lerp
        loop.events.on('pre-tick', () => {
            renderer.storePreviousState();
        });

        // render with interpolation
        loop.events.on('render', ({ alpha }) => {
            renderer.render(alpha);
        });

        // Display and update stats every second
        loop.events.on('tick', ({ tick }) => {
            if (tick % loop.ticker.rate !== 0) return;

            let totalVertexCount = 0;
            for (const p of gltfPrefabs) {
                totalVertexCount += p.totalVertexCount;
            }
            stats.textContent = `FPS: ${loop.fps} | Vertices: ${totalVertexCount} | Instantiations: ${instancesHandlers.length} (${instancesHandlers.length * totalVertexCount} vertexes)`;
        });

        // Remove all instances when pressing R
        loop.events.on('tick', ({ input }) => {
            if (input.keys['KeyR']?.hit) {
                for (const h of instancesHandlers) h.destroy();
                instancesHandlers.length = 0;
            }
        });

        // Spawn random instance when pressing T
        loop.events.on('tick', ({ input }) => {
            if (input.keys['KeyT']?.down) {
                trySpawnRandom();
            }
        });

        // camera mouselook
        loop.events.on('tick', ({ input }) => {
            mouseLook.update(input);

            const pos = renderer.camera.position;
            const f = mouseLook.forward;
            renderer.camera.setTarget(pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]);
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

        loop.start();

        return {
            onControlChange(key, value) {
                if (key === 'fov') renderer.camera.fov = value;
                else if (key === 'near') renderer.camera.near = value;
                else if (key === 'far') renderer.camera.far = value;
                else if (key === 'animationCullDistance') renderer.setAnimationCullDistance(value);
            },
            destroy() {
                loop.stop();
                mouseLook.destroy();
                renderer.destroy();
            },
        };
    },
};

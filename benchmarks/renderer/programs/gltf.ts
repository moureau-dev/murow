import { AssetBucket, GameLoop, Hitbox, HitboxLibrary, SimpleRNG, StateMachine, u16, type GltfPrefab } from 'murow';
import { MouseLook } from 'murow/core/input';
import { type InstanceHandle, type LightHandle, WebGPU3DRenderer } from 'murow/webgpu';

import type { Control, ControlValues, Program, ProgramHandle } from '..';

const DEFAULT_FOV = 70;
const DEFAULT_NEAR = 0.01;
const DEFAULT_FAR = 12;
const DEFAULT_INSTANCES = 2000;
const DEFAULT_SKINNING_CULL = 15;

const RED_PIXEL_PNG = '/hud.png';

const hitboxes = new HitboxLibrary('3d')
  .add('humanoid', new Hitbox('3d')
    .add('body', { shape: 'cylinder', radius: 40, height: 155, offset: [0, 80, 0] })
    .add('head', { shape: 'sphere', radius: 28, offset: [0, 180, 0] }))
  .add('minion', new Hitbox('3d').add('body', { shape: 'box', size: [50, 50, 50], offset: [0, 60, 0] }))
  .add('superMinion', new Hitbox('3d').add('body', { shape: 'box', size: [65, 65, 65], offset: [0, 60, 0] }));

const controls: Control[] = [
    { kind: 'number', key: 'instances', label: 'Instances', min: 1, max: 12_000, step: 100, default: DEFAULT_INSTANCES, restart: true },
    { kind: 'number', key: 'fov', label: 'FOV', min: 10, max: 170, step: 1, default: DEFAULT_FOV },
    { kind: 'number', key: 'near', label: 'Near', min: 0.001, max: 5, step: 0.01, default: DEFAULT_NEAR },
    { kind: 'number', key: 'far', label: 'Far', min: 1, max: 1000, step: 1, default: DEFAULT_FAR },
    { kind: 'number', key: 'animationCullDistance', label: 'Anim Cull', min: 1, max: 1000, step: 1, default: DEFAULT_SKINNING_CULL },
    { kind: 'number', key: 'ambient', label: 'Ambient', min: 0, max: 1, step: 0.01, default: 0.12 },
    { kind: 'number', key: 'flashlight', label: 'Flashlight (1/0)', min: 0, max: 1, step: 1, default: 1 },
    // Spot edge softness 0..1, live (a first-class light property via setSmoothness).
      { kind: 'number', key: 'feather', label: 'Spot Feather', min: 0, max: 1, step: 0.01, default: 0.4 },
];

const assets = new AssetBucket('3d')
  .textures(({ bucket }) => bucket
      .add({ type: 'texture', id: 'red-pixel', src: '/grass.jpg', metadata: { flipY: false } })
      .add({ type: 'texture', id: 'hud', src: `/hud.png`, metadata: { flipY: false } })
      .add({ type: 'texture', id: 'minecraft', src: `/minecraft.png`, metadata: { flipY: false } })
  )
  .prefabs(({ bucket }) => bucket
    .hitboxes(hitboxes)
    .add({
        type: 'gltf',
        id: 'model',
        src: 'https://raw.githubusercontent.com/8thwall/web/72556f9122f5b0e861f55748cc9a938a59691273/examples/aframe/animation-mixer/mixamo-animated-lowpoly.glb',
        metadata: { scale: 0.175 },
    })
    // .add({
    //     type: 'gltf',
    //     id: 'caitlyn',
    //     src: '/caitlyn.glb',
    //     metadata: { scale: 0.00175 },
    //     hitbox: 'humanoid',
    // })
    // .add({
    //     type: 'gltf',
    //     id: 'annie',
    //     src: '/annie.glb',
    //     metadata: { scale: 0.00175 },
    //     hitbox: 'humanoid',
    // })
    // .add({
    //     type: 'gltf',
    //     id: 'jinx',
    //     src: '/jinx.glb',
    //     metadata: { scale: 0.00175 },
    //     hitbox: 'humanoid',
    // })
    // .add({
    //     type: 'gltf',
    //     id: 'orianna',
    //     src: '/orianna.glb',
    //     metadata: { scale: 0.00175 },
    //     hitbox: 'humanoid',
    // })
    .add({
        type: 'plane',
        id: 'wall',
        texture: 'red-pixel',
        height: 1,
        width: 1,
        metadata: { flipY: false },
    })
    .add({
        type: 'gltf',
        id: 'super-minion',
        src: '/super-minion.glb',
        metadata: { scale: 0.00175 },
        hitbox: 'superMinion',
    })
    .add({
        type: 'gltf',
        id: 'minion',
        src: '/minion.glb',
        metadata: { scale: 0.00175 },
        hitbox: 'minion',
    })
    .add({
        type: 'grid',
        id: 'floor',
        size: 20,
        step: 0.33,
        lineWidth: 0.001,
    })
    .add({ type: 'cube', id: 'cube', size: 1, metadata: { hp: 10 }, uv: 'cross', texture: 'minecraft' })
    .add({ type: 'cube', id: 'crate', size: 1, metadata: { hp: 10 } })
    .add({ type: 'cube', id: 'campfire.logs', size: 1 })
    .add({ type: 'cube', id: 'campfire.flame', size: 0.3 })
    .add({ type: 'cube', id: 'campfire.ember', size: 0.5 })
    .add({
        type: 'composite', id: 'campfire',
        parts: [
            { partId: 'campfire.logs' },
            { partId: 'campfire.flame', offset: { position: [0, 0.3, 0] } },
            { partId: 'campfire.ember', offset: { position: [0, 0.8, 0] } },
        ],
    })
  );


export const gltf: Program = {
    name: '3D glTF',
    controls,

    async init(canvas: HTMLCanvasElement, stats: HTMLElement, values: ControlValues): Promise<ProgramHandle> {
        const instances = Math.max(1, Math.floor(values.instances ?? DEFAULT_INSTANCES));

        await assets.load();

        const renderer = new WebGPU3DRenderer(canvas, {
            clearColor: [0.15, 0.15, 0.2, 1],
            autoResize: true,
            assets,
            maxInstances: instances,
            animationCullDistance: values.animationCullDistance ?? DEFAULT_SKINNING_CULL,
        });

        await renderer.init();

        // --- Lighting ---
        // Dim the global terms so the dynamic lights read clearly, then drop a
        // couple of colored point lights into the scene and a camera-mounted
        // spotlight (flashlight). The flashlight is moved every TICK below, not
        // every frame -- it stays smooth at the 15 Hz tick because light
        // position/direction interpolate (mix(prev, curr, alpha)) on the GPU.
        renderer.lights.sun([0.3, 0.8, 0.5], [0.7, 0.75, 0.9], 0.4);
        renderer.lights.ambient([0.12, 0.12, 0.12]);

        // Warm light over the campfire group (spawned at [10, 0, 5] below).
        renderer.lights.add({ type: 'point', position: [10, 1.2, 5], color: [1, 0.55, 0.2], intensity: 1.4, range: 6 });
        // Cool fill light across the arena.
        renderer.lights.add({ type: 'point', position: [3, 2, 14], color: [0.3, 0.5, 1], intensity: 1.2, range: 10 });

        const flashlight: LightHandle = renderer.lights.add({
            type: 'spot',
            position: [0, 0, 0],
            direction: [0, 0, -1],
            color: [1, 0.97, 0.85],
            // Tone mapping (Reinhard) rolls brightness off smoothly, so the cone
            // can be punchy without clipping to a flat white disc -- the feathered
            // edge stays visible as a gradient.
            intensity: 3,
            range: 12,
            angle: 0.5,                          // cone half-angle (radians)
            smoothness: values.feather ?? 0.4,   // 0 = hard edge, 1 = fades from center
        });
        flashlight.enabled = (values.flashlight ?? 1) > 0.5;

        // A magenta point light skating a figure-8 (lemniscate of Gerono) just
        // above the floor. Moved every TICK in the loop below -- it glides
        // smoothly between ticks because light position interpolates on the GPU.
        const FIG8_CENTER: [number, number, number] = [6, 0.4, 6];
        const FIG8_RADIUS = 1;
        const FIG8_SPEED = 0.9;   // radians/sec around the curve
        const fig8 = renderer.lights.add({
            type: 'point',
            position: FIG8_CENTER,
            color: [1, 0.2, 0.8],
            intensity: 3,
            range: 5,
        });

        const rng = new SimpleRNG(1212121);

        // Each animated instance runs a behavior FSM: hold an idle clip, then
        // play a random "act" clip, then back to idle. State lives in the
        // machine's columns; transitions fire `change`, which drives play().
        const animCapacity = renderer.maxSkinned;
        const anim = new StateMachine({
            initial: 'idle',
            capacity: animCapacity,
            rng,
            states: {
                idle: { hold: u16 },
                act: { hold: u16 },
            },
        })
            .add('idle', {
                enter: (e) => { e.hold = 30 + rng.int(0, 90); },
                update: (e) => { if (e.ticksInState >= e.hold) e.change('act'); },
            })
            .add('act', {
                enter: (e) => { e.hold = 20 + rng.int(0, 40); },
                update: (e) => { if (e.ticksInState >= e.hold) e.change('idle'); },
            });

        const animView = new Map<number, { instance: InstanceHandle; clips: string[] }>();
        const freeAnimIds: number[] = [];
        for (let i = animCapacity - 1; i >= 0; i--) freeAnimIds.push(i);

        const playFor = (id: number) => {
            const view = animView.get(id);
            if (!view || view.clips.length === 0) return;

            const handle = anim.of(id);
            if (!handle) return;

            const clip = handle.is('idle') ? view.clips[0]! : rng.pick(view.clips);
            view.instance.play?.(clip, { loop: true, crossfade: 0.15 });
        };

        anim.events.on('change', ({ id }) => playFor(id));

        const resetAnim = () => {
            for (const id of animView.keys()) anim.remove(id);
            animView.clear();
            freeAnimIds.length = 0;
            for (let i = animCapacity - 1; i >= 0; i--) freeAnimIds.push(i);
        };

        const gltfPrefabs = assets.prefabs.entries().filter((p): p is GltfPrefab => p?.type === 'gltf');
        const instancesHandlers: ReturnType<typeof renderer.instances.add>[] = [];

        const trySpawnRandom = () => {
              const forbidden = instancesHandlers.length >= renderer.maxSkinned
              if (forbidden) return;

              const prefab = rng.pick(gltfPrefabs);
              if (!prefab) return;

              const id = freeAnimIds.pop();
              if (id === undefined) return;

              const scale = (prefab.metadata.scale as number | undefined) ?? 1;

              const instance = renderer.instances.add({
                  prefab,
                  position: [rng.rand() * 20, 0, rng.rand() * 20],
                  scale,
              });

              instancesHandlers.push(instance);

              animView.set(id, { instance, clips: [...(prefab.animationList ?? [])] });
              anim.spawn(id);
              playFor(id);
              return instance;
        }

        for (let i = 0; i < instances; i++) trySpawnRandom();

        // Grid floor
        renderer.instances.add({ prefab: assets.prefabs.get('floor'), color: [0.25, 0.25, 0.3] });
        instancesHandlers.push(renderer.instances.add({
            prefab: 'wall',
            rotation: [Math.PI / 2, 0, 0],
            position: [0, 2, 2],
            color: [0.5, 0.5, 0.5],
            texture: 'hud',
        }));
        instancesHandlers.push(renderer.instances.add({
            prefab: 'cube',
            rotation: [0, 0, 0],
            position: [0, 0.5, 1],
            scale: [.4, .4, .4],
        }));


        // Big Black Cube
        instancesHandlers.push(renderer.instances.add({ prefab: assets.prefabs.get('crate'), color: [0.2, 0.1, 0.05] }));

        // Spawn the whole group as one logical instance
        instancesHandlers.push(renderer.instances.add({ prefab: assets.prefabs.get('campfire'), position: [10, 0, 5] }));

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

        // canvas.addEventListener('click', () => {
        //     mouseLook.lock(canvas).catch(() => { /* drag-to-look fallback */ });
        // });

        const loop = new GameLoop({ tickRate: 15, type: 'client' });

        const MOVE_SPEED = 1.5;

        // prepare GPU lerp
        loop.events.on('pre-tick', () => {
            renderer.storePreviousState();
        });

        // render with interpolation (camera, instances positions, lights...)
        loop.events.on('render', ({ alpha }) => {
            renderer.render(alpha);
        });

        // advance every instance's behavior FSM once per tick
        loop.events.on('tick', () => anim.tick());

        // Display and update stats every second
        loop.events.on('tick', ({ tick }) => {
            if (tick % loop.ticker.rate !== 0) return;

            let totalVertexCount = 0;
            for (const p of gltfPrefabs) {
                totalVertexCount += p.totalVertexCount;
            }
            stats.textContent = `FPS: ${loop.fps} | Vertices: ${totalVertexCount} | Instantiations: ${instancesHandlers.length} (${instancesHandlers.length * totalVertexCount} vertexes)`;
        });

        loop.events.on('tick', ({ input }) => {
            // Remove all instances when pressing R
            if (input.keys['KeyR']?.hit) {
                for (const h of instancesHandlers) h.destroy();
                instancesHandlers.length = 0;
                resetAnim();
            }

            // Spawn random instance when pressing T
            if (input.keys['KeyT']?.down) {
                trySpawnRandom();
            }

            // Toggle hitbox debug draw when pressing B
            if (input.keys['KeyB']?.hit) {
                renderer.debug.hitboxes = !renderer.debug.hitboxes;
            }
        });

        // Refresh the raycaster against the cursor every tick.
        loop.events.on('tick', ({ input }) => {
            renderer.raycast.update(input);
        });

        // Click a Jinx -> drop a crate at her position. Headshots glow gold.
        loop.events.on('tick', ({ input }) => {
            if (!input.mouse.left.hit) return;

            const jinx = renderer.raycast.hit({ filter: (h) => h.prefabId === 'jinx' });
            if (!jinx) return;

            const [px, py, pz] = jinx.handle.position;
            const headshot = jinx.part === 'head';
            instancesHandlers.push(renderer.instances.add({
              prefab: assets.prefabs.get('crate'),
              position: [px, py, pz],
              scale: 0.3,
              color: headshot ? [1, 0.85, 0.1] : [1, 0.2, 0.4],
            }));
        });

        // camera mouselook
        loop.events.on('tick', ({ input }) => {
            mouseLook.update(input);

            const pos = renderer.camera.position;
            const f = mouseLook.forward;
            renderer.camera.setTarget(pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]);

            // Flashlight tracks the camera. Updated at TICK rate; the light still
            // glides at render rate because position/direction interpolate.
            flashlight.setPosition(pos[0], pos[1], pos[2]);
            flashlight.setDirection(f[0], f[1], f[2]);
        });

        // Figure-8 point light. Lemniscate of Gerono: x = R*cos(t), z = R*sin(t)*cos(t).
        // `t` comes from the tick clock (deterministic, no Date.now).
        loop.events.on('tick', ({ tick }) => {
            const t = (tick / loop.ticker.rate) * FIG8_SPEED;
            const cos = Math.cos(t);
            const sin = Math.sin(t);
            fig8.setPosition(
                FIG8_CENTER[0] + FIG8_RADIUS * cos,
                FIG8_CENTER[1],
                FIG8_CENTER[2] + FIG8_RADIUS * sin * cos,
            );
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
                else if (key === 'ambient') renderer.lights.ambient([value, value, value]);
                else if (key === 'flashlight') flashlight.enabled = value > 0.5;
                else if (key === 'feather') flashlight.smoothness = value;
            },
            destroy() {
                loop.stop();
                mouseLook.destroy();
                renderer.destroy();
            },
        };
    },
};

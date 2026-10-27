import { InputSnapshot, SlotStore, Transports, type Entity } from 'murow';
import { MouseLook, ScrollZoom } from 'murow/core/input';
import { GameClient } from 'murow/netcode';
import { WebGPU3DRenderer } from 'murow/webgpu';
import { AssetBucket } from 'murow/renderer';
import type { Handles } from 'murow/renderer/managers/handles';
import type { CameraManager } from 'murow/renderer/managers/runtime';
import {
    ARENA_HALF,
    Arena,
    CELL_SIZE,
    Components,
    WS_PATH,
    protocol,
    predictions,
    clamp,
} from '../shared';

// ──────────────────────────────────────────────────────────────────────
// World + client
// ──────────────────────────────────────────────────────────────────────

const arena = new Arena('client');
// Same host:port the page came from; `wss://` if the page is HTTPS.
// In `vite dev`, the Vite server proxies WS_PATH through to the Bun
// server, so this URL works in both dev and prod without changes.
const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
const uri = new URL(WS_PATH, location.origin);
uri.protocol = wsScheme;

const transport = new Transports.BrowserWs(uri.toString());

const MIN_DELAY_MS = 3 * arena.loop.ticker.intervalMs;
const MAX_DELAY_MS = 600;

const client = new GameClient({
    world: arena.world,
    loop: arena.loop,
    transport,
    protocol,
    strategy: { // optional. defaults to { kind: 'snapshot-interpolation' }
        kind: 'snapshot-interpolation', // currently the only implemented strategy. more to come later!
        delay: MIN_DELAY_MS, // optional. Snapshot interpolation delay, ms. Default 100.
        staleWindow: MAX_DELAY_MS * 2 + 100, //  optional. Max ms between snapshots before history is dropped as stale. Defaults to delay * 2 + 100.
        maxDesync: 700, // optional. Desync past which the play-out clock snaps instead of warping, ms. Scaled by tick rate internally. Default 500.
        maxBridgeGap: 250, // optional. Largest data gap a peer may have before its value is held instead of interpolated across, ms. Smaller gaps are bridged. Default 250.
    },
});
client.use(predictions);

// ──────────────────────────────────────────────────────────────────────
// Renderer ↔ World bridge: one handle per networked entity.
// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────
// Renderer + prefabs
// ──────────────────────────────────────────────────────────────────────

const { canvas, playerCount, status, mobile} = setup();

const assets = new AssetBucket('3d')
    .prefabs(({ bucket }) => bucket
        .add({
            type: 'grid',
            id: 'floor',
            size: ARENA_HALF * 2 + 2,
            step: CELL_SIZE,
            lineWidth: 0.01,
        })
        .add({ type: 'cube', id: 'player', size: 0.9 })
    );

await assets.load();

const renderer = new WebGPU3DRenderer(canvas, {
    clearColor: [0.05, 0.07, 0.13, 1],
    autoResize: true,
    assets,
    maxInstances: 64,
    camera: false, // no default camera
});

const camera = renderer.cameras.create({
    fov: 65,
    near: 0.05,
    far: 100,
});

await renderer.init();

// Static grid floor — never moves, no per-tick update needed.
renderer.instances.add({
    prefab: assets.prefabs.get('floor'),
    color: [0.2, 0.25, 0.35],
    position: [0, 0, 0],
});

const handles = new SlotStore<Entity, Handles.MeshInstanceHandle>(renderer.maxInstances);

client.on('spawn', ({ entity }) => {
    const c = arena.world.has(entity, Components.Color) ? arena.world.get(entity, Components.Color) : { r: 200, g: 200, b: 200 };
    const p = arena.world.has(entity, Components.Position) ? arena.world.get(entity, Components.Position) : { x: 0, z: 0 };

    handles.add(entity, renderer.instances.add({
        prefab: assets.prefabs.get('player'),
        color: [c.r / 255, c.g / 255, c.b / 255],
        position: [p.x, 0.45, p.z],
    }));

    playerCount.textContent = String(handles.size);
});

client.on('despawn', ({ entity }) => {
    const handle = handles.get(entity);
    if (handle !== undefined) {
        handle.destroy();
        handles.remove(entity);
    }

    playerCount.textContent = String(handles.size);
});

client.on('connected', () => {
    status.textContent = 'connected';
    status.className = 'connected';
});

client.on('disconnected', ({ reason }) => {
    status.textContent = `disconnected (${reason})`;
    status.className = 'disconnected';
});

client.on('error', ({ error, context }) => {
    console.error(`[client] ${context}:`, error);
});


// ──────────────────────────────────────────────────────────────────────
// Game loop wiring.
// ──────────────────────────────────────────────────────────────────────

const systems = createSystems({ client, camera });

// prepare gpu lerp
arena.loop.events.on('pre-tick', () => {
    renderer.storePreviousState();
});
// execute gpu lerp
arena.loop.events.on('render', ({ alpha }) => {
    renderer.render(alpha);
});

arena.loop.events.on('tick', ({ input }) => {
    systems.move(input);
    systems.orbit(input);
    systems.sync()
});

// Ping once every 2 seconds so the delay estimate tracks RTT swings.
arena.loop.every(2).seconds(() => {
    client.ping();
});

client.on('pong', ({ rtt }) => {
    systems.pong(rtt);
});

arena.loop.start();

function createSystems({
    client, 
    camera,
}: { 
    client: GameClient, 
    camera: CameraManager,
}) {
    const world = client.world;
    const position = world.fields(Components.Position);
    const { mouseLook, zoom } = createCameraCtrl();
    const pingEl = document.getElementById('ping')!;

    return {
        /**
         * Syncs renderer instances with world.
         */
        sync: () => {
            for (const eid of world.query(Components.Position)) {
                const handle = handles.get(eid);
                if (!handle) continue;

                const x = position.x[eid];
                const z = position.z[eid];

                handle.setPosition(x, 0.45, z);
            }
        },
        /**
         * Sends move intent from keyboard input
         */
        move: (input: InputSnapshot) => {
            // Read WASD into a 2D direction.
            let dx = 0;
            let dz = 0;
            if (input.keys['KeyW']?.down || mobile.forward) dz -= 1;
            if (input.keys['KeyS']?.down || mobile.back)    dz += 1;
            if (input.keys['KeyA']?.down || mobile.left)    dx -= 1;
            if (input.keys['KeyD']?.down || mobile.right)   dx += 1;
        
            // Rotate the WASD vector by the camera yaw so "W" always moves away
            // from the camera, "A" always strafes left, etc.
            const yawCos = Math.cos(mouseLook.yaw);
            const yawSin = Math.sin(mouseLook.yaw);
            const localDx = dx * yawCos + dz * yawSin;
            const localDz = -dx * yawSin + dz * yawCos;
        
            // Normalize (so diagonals don't move faster).
            const mag = Math.hypot(localDx, localDz);
            const ndx = mag > 0 ? localDx / mag : 0;
            const ndz = mag > 0 ? localDz / mag : 0;
        
            if (ndx === 0 && ndz === 0) return;

            // Send delta
            client.sendIntent('move', { dx: ndx, dz: ndz });
        },
        /**
         * Camera orbit
         */
        orbit: (input: InputSnapshot) => {
            const eid = client.assignedEntity;
            if (!eid) return;

            mouseLook.update(input);
            zoom.update(input);

            const ty = 0.45;
            const tx = position.x[eid] ?? 0;
            const tz = position.z[eid] ?? 0;

            const [cx, cy, cz] = mouseLook.orbit([tx, ty, tz], zoom.value);
            camera.setPosition(cx, cy, cz);
            camera.setTarget(tx, ty, tz);
        },
        /**
         * Calculates and sets interpolation delay from
         * ping acks received.
         */
        pong: (rtt: number) => {
            const ping = rtt / 2 + client.loop.ticker.intervalMs;
            const target = clamp(ping, MIN_DELAY_MS, MAX_DELAY_MS);
            client.setInterpolationDelay(target);
            client.setMaxBridgeGap(target * 2); // optional, but good to scale together with delay
            pingEl.textContent = `${Math.round(rtt)} ms (buffer ${Math.round(target)} ms)`;
        }
    }
}

function createCameraCtrl() {
    const mouseLook = new MouseLook({
        sensitivity: 0.0035,
        yaw: { initial: Math.PI * 0.25 },
        pitch: { initial: 0.6, min: 0.15, max: Math.PI / 2 - 0.05 },
        drag: true, // allows mobile
    });

    const zoom = new ScrollZoom({
        initial: 8,
        min: 3,
        max: 20,
        sensitivity: 0.005,
    });
    
    canvas.addEventListener('click', () => {
        mouseLook.lock(canvas).catch(() => { /* iOS: drag-to-look takes over */ });
    });

    return {
        mouseLook,
        zoom,
    }
}

function setup() {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    const status = document.getElementById('status')!;
    const playerCount = document.getElementById('playerCount')!;
    
    const buttons = {
        forward: document.getElementById('mobileForward'),
        right: document.getElementById('mobileRight'),
        back: document.getElementById('mobileBack'),
        left: document.getElementById('mobileLeft'),
    };

    const mobile = {
        forward: false,
        back: false,
        right: false,
        left: false,
    };

    function wire(btn: HTMLElement, set: (v: boolean) => void) {
        btn.onpointerdown  = (e) => { e.preventDefault(); set(true); };
        btn.onpointerup    = () => set(false);
        btn.onpointerleave = () => set(false);
    }

    wire(buttons.forward, (v) => { mobile.forward = v; });
    wire(buttons.back,    (v) => { mobile.back    = v; });
    wire(buttons.left,    (v) => { mobile.left   = v; });
    wire(buttons.right,   (v) => { mobile.right   = v; });

    return { canvas, status, playerCount, mobile };
}

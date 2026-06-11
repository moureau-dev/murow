import { PrefabBucket, Transports, type Entity } from 'murow';
import { MouseLook, ScrollZoom } from 'murow/core/input';
import { GameClient } from 'murow/netcode';
import { WebGPU3DRenderer, type InstanceHandle } from 'murow/webgpu';
import {
    ARENA_HALF,
    Arena,
    CELL_SIZE,
    Components,
    WS_PATH,
    intents,
    predictions,
    rpcs,
    clamp,
} from '../shared';

// ──────────────────────────────────────────────────────────────────────
// Renderer + prefabs
// ──────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;
const playerCountEl = document.getElementById('playerCount')!;
const mobileForwardBtn = document.getElementById('mobileForward')!;
const mobileBackBtn    = document.getElementById('mobileBack')!;
const mobileLeftBtn    = document.getElementById('mobileLeft')!;
const mobileRightBtn   = document.getElementById('mobileRight')!;

let mobileForward = false, mobileBack = false, mobileLeft = false, mobileRight = false;

function wire(btn: HTMLElement, set: (v: boolean) => void) {
    btn.onpointerdown  = (e) => { e.preventDefault(); set(true); };
    btn.onpointerup    = () => set(false);
    btn.onpointerleave = () => set(false);
}
wire(mobileForwardBtn, (v) => { mobileForward = v; });
wire(mobileBackBtn,    (v) => { mobileBack    = v; });
wire(mobileLeftBtn,    (v) => { mobileLeft    = v; });
wire(mobileRightBtn,   (v) => { mobileRight   = v; });

const prefabs = new PrefabBucket('3d')
    .add({
        type: 'grid',
        id: 'floor',
        size: ARENA_HALF * 2 + 2,
        step: CELL_SIZE,
        lineWidth: 0.01,
    })
    .add({ type: 'cube', id: 'player', size: 0.9 });

await prefabs.load();

const renderer = new WebGPU3DRenderer(canvas, {
    clearColor: [0.05, 0.07, 0.13, 1],
    autoResize: true,
    prefabs,
    maxInstances: 64,
});
await renderer.init();

// Static grid floor — never moves, no per-tick update needed.
renderer.addInstance({
    model: prefabs.get('floor'),
    color: [0.2, 0.25, 0.35],
    position: [0, 0, 0],
});

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
    protocol: { intents, rpcs },
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

const handles = new Map<Entity, InstanceHandle>();
let localEntity: Entity | null = null;

client.on('spawn', ({ entity }) => {
    const c = arena.world.has(entity, Components.Color) ? arena.world.get(entity, Components.Color) : { r: 200, g: 200, b: 200 };
    const p = arena.world.has(entity, Components.Position) ? arena.world.get(entity, Components.Position) : { x: 0, z: 0 };
    const handle = renderer.addInstance({
        model: prefabs.get('player'),
        color: [c.r / 255, c.g / 255, c.b / 255],
        position: [p.x, 0.45, p.z],
    });
    handles.set(entity, handle);
    playerCountEl.textContent = String(handles.size);
});

// The server tells us which entity is ours via `assignEntity`. The
// client auto-marks it predicted; we just need to remember which one
// it is so the WASD intent targets the right entity.
client.on('assigned', ({ entity }) => {
    localEntity = entity;
});

client.on('despawn', ({ entity }) => {
    const handle = handles.get(entity);
    if (handle !== undefined) {
        handle.destroy();
        handles.delete(entity);
    }
    if (localEntity === entity) localEntity = null;
    playerCountEl.textContent = String(handles.size);
});

client.on('connected', () => {
    statusEl.textContent = 'connected';
    statusEl.className = 'connected';
});

client.on('disconnected', ({ reason }) => {
    statusEl.textContent = `disconnected (${reason})`;
    statusEl.className = 'disconnected';
});

client.on('error', ({ error, context }) => {
    console.error(`[client] ${context}:`, error);
});


// ──────────────────────────────────────────────────────────────────────
// Third-person orbit camera (local state only — not networked).
// ──────────────────────────────────────────────────────────────────────

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

renderer.camera.fov = 65;
renderer.camera.near = 0.05;
renderer.camera.far = 100;

// ──────────────────────────────────────────────────────────────────────
// Game loop wiring.
// ──────────────────────────────────────────────────────────────────────

// prepare gpu lerp
arena.loop.events.on('pre-tick', () => {
    renderer.storePreviousState();
});
// execute gpu lerp
arena.loop.events.on('render', ({ alpha }) => {
    renderer.render(alpha);
});

const pingEl = document.getElementById('ping')!;

// Ping twice every second so the delay estimate tracks RTT swings.
arena.loop.every(500).milliseconds(() => {
    client.ping();
});

client.on('pong', ({ rtt }) => {
    const ping = rtt / 2 + arena.loop.ticker.intervalMs;
    const target = clamp(ping, MIN_DELAY_MS, MAX_DELAY_MS);
    client.setInterpolationDelay(target);
    client.setMaxBridgeGap(target * 2); // optional, but good to scale together with delay
    pingEl.textContent = `${Math.round(rtt)} ms (buffer ${Math.round(target)} ms)`;
});

// controls
arena.loop.events.on('tick', ({ input }) => {
    // Read WASD into a 2D direction.
    let dx = 0;
    let dz = 0;
    if (input.keys['KeyW']?.down || mobileForward) dz -= 1;
    if (input.keys['KeyS']?.down || mobileBack)    dz += 1;
    if (input.keys['KeyA']?.down || mobileLeft)    dx -= 1;
    if (input.keys['KeyD']?.down || mobileRight)   dx += 1;

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

    if (ndx !== 0 || ndz !== 0) {
        client.sendIntent('move', { dx: ndx, dz: ndz });
    }
});

// sync entities world -> renderer (automatically lerps)
arena.loop.events.on('tick', () => {
    for (const [entity, handle] of handles) {
        if (!arena.world.has(entity, Components.Position)) continue;
        const p = arena.world.get(entity, Components.Position);
        handle.setPosition(p.x, 0.45, p.z);
    }
});

// camera orbit
arena.loop.events.on('tick', ({ input }) => {
    mouseLook.update(input);
    zoom.update(input);

    let tx = 0, ty = 0.45, tz = 0;
    if (localEntity !== null && arena.world.has(localEntity, Components.Position)) {
      const lp = arena.world.get(localEntity, Components.Position);
      tx = lp.x; tz = lp.z;
    }
    const [cx, cy, cz] = mouseLook.orbit([tx, ty, tz], zoom.value);
    renderer.camera.setPosition(cx, cy, cz);
    renderer.camera.setTarget(tx, ty, tz);
});

arena.loop.start();

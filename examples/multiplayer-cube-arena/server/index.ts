import { BunWebSocketServerTransport, SimpleRNG } from 'murow';
import { GameServer } from 'murow/netcode';
import {
    PORT,
    TICK_RATE,
    WS_PATH,
    Arena,
    intents,
    predictions,
    Components,
    rpcs,
} from '../shared';

/**
 * Authoritative server. Spawns a cube per connecting peer at a random
 * spawn point, assigns it a random color, lets the shared `move`
 * prediction handle movement (it runs as the authoritative apply here),
 * and ships snapshot deltas at TICK_RATE Hz.
 */

const arena = new Arena('server-timeout');

// Single Bun listener: WS upgrades at WS_PATH, everything else falls
// through to the static-file fetch handler below so the built client
// bundle and the WebSocket share one port.
const distRoot = './client/dist';
const transport = BunWebSocketServerTransport.create(PORT, {
    path: WS_PATH,
    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname === '/' ? '/index.html' : url.pathname;

        const file = Bun.file(`${distRoot}${path}`);
        if (await file.exists()) {
            return new Response(file);
        }

        // SPA-style fallback to index.html for unknown paths.
        if (!path.includes('.')) {
            return new Response(Bun.file(`${distRoot}/index.html`), {
                headers: { 'Content-Type': 'text/html' },
            });
        }
        return new Response('Not Found', { status: 404 });
    },
});

const server = new GameServer({
    loop: arena.loop,
    world: arena.world,
    transport,
    protocol: { intents, rpcs },
    snapshot: { rate: TICK_RATE },
});
server.use(predictions);

// Deterministic spawn / color picker so reconnecting peers don't collide
// at exactly the same point.
const rng = new SimpleRNG(0xC0FFEE);
const PALETTE: [number, number, number][] = [
    [78, 205, 196],
    [255, 107, 107],
    [255, 211, 105],
    [186, 220, 88],
    [165, 105, 189],
    [86, 152, 234],
    [241, 130, 141],
    [255, 159, 67],
];

server.on('connection', ({ peer }) => {
    const e = arena.world.spawn();
    const spawnX = (rng.rand() - 0.5) * 12;
    const spawnZ = (rng.rand() - 0.5) * 12;
    const palette = rng.pick(PALETTE);

    arena.world.add(e, Components.Position, { x: spawnX, z: spawnZ });
    arena.world.add(e, Components.Color, { r: palette[0], g: palette[1], b: palette[2] });

    server.assignEntity(peer, e);
    console.log(`[server] peer ${peer.peerId} → entity ${e} at (${spawnX.toFixed(2)}, ${spawnZ.toFixed(2)})`);
});

server.on('disconnection', ({ peer, reason }) => {
    const entity = peer.entity;
    if (entity !== -1 && arena.world.isAlive(entity)) {
        arena.world.despawn(entity);
    }
    console.log(`[server] peer ${peer.peerId} left (${reason})`);
});

server.on('error', ({ error, context }) => {
    console.error(`[server] error in ${context}:`, error);
});

console.log(`[server] listening on http://localhost:${PORT} (ws path: ${WS_PATH})`);
arena.loop.start();

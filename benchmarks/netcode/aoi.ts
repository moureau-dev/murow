/**
 * AOI snapshot benchmark — run with:
 *
 *   bun run benchmarks/netcode/aoi.ts
 *
 * Env knobs:
 *   ENTITIES    (default 2000)   world units carrying the AOI position component
 *   PEERS       (default 24)     connected peers (each assigned one player entity)
 *   TICKS       (default 400)    sampled ticks
 *   RADIUS      (default 50)     AOI radius
 *   BOUNDS      (default 0)      with 1, entities carry a Box and use AABB interest;
 *                                runs point and bounds plugin timings side by side
 *   WORLD_SIZE  (default 1000)   square world extent entities are scattered over
 *   LABEL       (free-form tag printed with the results)
 *
 * Reports two timings:
 *   grid  — AoiGrid.onTick (rebuild the grid) + nearby() per peer
 *   full  — the whole server tick (loop.step -> post-tick -> sendSnapshots)
 *
 * With BOUNDS=1 it prints `grid-pt` (point radius) and `grid-bx` (AABB) and
 * runs `full` on the bounds grid. The two plugin timings are primed and measured
 * A/B/B/A with the min of each kept, so process warmup does not favour whichever
 * runs second.
 *
 * `full` is the headline. The `grid` line is the plugin's own share; the rest is
 * the core (candidate/interest passes + encode).
 */
import { defineComponent, GameLoop, SimpleRNG, World, type Entity } from 'murow';
import { f32 } from 'murow/core/binary-codec';
import type { ServerTransportAdapter, TransportAdapter } from 'murow';
import { AoiGrid, GameServer, defineIntents, defineRpcs, networked } from 'murow/netcode';

const ENTITIES = Number(process.env.ENTITIES ?? 2000);
const PEERS = Number(process.env.PEERS ?? 24);
const TICKS = Number(process.env.TICKS ?? 400);
const RADIUS = Number(process.env.RADIUS ?? 50);
const WORLD_SIZE = Number(process.env.WORLD_SIZE ?? 1000);
const INTERVAL = Number(process.env.INTERVAL ?? 1);
const CAPACITY = Number(process.env.CAPACITY ?? 0);
const LABEL = process.env.LABEL ?? 'run';
const BOUNDS = process.env.BOUNDS === '1' || process.env.BOUNDS === 'true' || process.env.BOUNDS === 'yes';
const TICK_RATE = 20;

const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: networked({ rate: 'every-tick', interest: 'aoi', interp: 'lerp' }),
});
const Box = defineComponent('Box', { hx: f32, hy: f32 });

class SinkPeer implements TransportAdapter {
    sent = 0;
    send(_data: Uint8Array): void { this.sent++; }
    onMessage(_handler: (data: Uint8Array) => void): void { /* server -> client only */ }
    onClose(_handler: () => void): void { /* no-op */ }
    close(): void { /* no-op */ }
}

class SinkServer implements ServerTransportAdapter<SinkPeer> {
    private peers = new Map<string, SinkPeer>();
    private conn: ((peer: SinkPeer, id: string) => void) | null = null;
    onConnection(handler: (peer: SinkPeer, id: string) => void): void { this.conn = handler; }
    onDisconnection(_handler: (id: string) => void): void { /* no-op */ }
    getPeer(id: string): SinkPeer | undefined { return this.peers.get(id); }
    getPeerIds(): string[] { return [...this.peers.keys()]; }
    close(): void { this.peers.clear(); }
    addPeer(id: string): void {
        const peer = new SinkPeer();
        this.peers.set(id, peer);
        this.conn?.(peer, id);
    }
}

function measure(iters: number, fn: (i: number) => void): number {
    for (let i = 0; i < Math.min(iters, 50); i++) fn(i);   // warm up
    Bun.gc(true);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    return (performance.now() - t0) / iters;
}

function run(label: string, iters: number, fn: (i: number) => void): number {
    const msPerOp = measure(iters, fn);
    console.log(`${label.padEnd(8)} ${msPerOp.toFixed(4)} ms/op`);
    return msPerOp;
}

console.log(
    `\n[${LABEL}] entities=${ENTITIES} peers=${PEERS} radius=${RADIUS} world=${WORLD_SIZE} interval=${INTERVAL} ticks=${TICKS} bounds=${BOUNDS ? 1 : 0}\n`,
);

const world = new World({ maxEntities: CAPACITY > 0 ? CAPACITY : ENTITIES + PEERS + 8, components: BOUNDS ? [Position, Box] : [Position] });
const rng = new SimpleRNG(0xc0ffee);
const units: Entity[] = [];
const xs = new Float32Array(ENTITIES);
const ys = new Float32Array(ENTITIES);
for (let i = 0; i < ENTITIES; i++) {
    const e = world.spawn();
    xs[i] = rng.range(0, WORLD_SIZE);
    ys[i] = rng.range(0, WORLD_SIZE);
    world.add(e, Position, { x: xs[i]!, y: ys[i]! });
    if (BOUNDS) world.add(e, Box, { hx: rng.range(2, 8), hy: rng.range(2, 8) });
    units.push(e);
}
const players: Entity[] = [];
for (let p = 0; p < PEERS; p++) {
    const e = world.spawn();
    world.add(e, Position, { x: rng.range(0, WORLD_SIZE), y: rng.range(0, WORLD_SIZE) });
    if (BOUNDS) world.add(e, Box, { hx: 6, hy: 6 });
    players.push(e);
}

/** Nudge every unit + player so the whole set is dirty each tick. */
function advance(tick: number): void {
    const p = world.fields(Position);
    const drift = Math.sin(tick * 0.01) * 0.5;
    for (let i = 0; i < units.length; i++) {
        const e = units[i]!;
        p.x[e] = xs[i]! + drift;
        p.y[e] = ys[i]! + drift;
        world.markDirty(e, Position.__worldIndex!);
    }
    for (let i = 0; i < players.length; i++) {
        const e = players[i]!;
        p.x[e] = p.x[e]! + drift;
        p.y[e] = p.y[e]! + drift;
        world.markDirty(e, Position.__worldIndex!);
    }
}

const makeAoi = (withBounds: boolean) => new AoiGrid({
    cellSize: 32, radius: RADIUS, hysteresisRadius: 4, interval: INTERVAL,
    positionComponent: Position, boundsComponent: withBounds ? Box : undefined,
});
const out: Entity[] = [];
const fakePeer = (entity: Entity) => ({ entity } as never);

function pluginRun(grid: AoiGrid): void {
    for (let p = 0; p < PEERS; p++) {
        out.length = 0;
        grid.nearby(fakePeer(players[p]!), world, out);
    }
}

advance(1);

// --- plugin only: rebuild the grid + query each peer's neighborhood ---------
let aoi = makeAoi(false);
let pluginMs: number;
if (BOUNDS) {
    const pointGrid = makeAoi(false);
    const boundsGrid = makeAoi(true);
    const ptFn = (i: number) => {
        if (i % INTERVAL === 0) pointGrid.onTick(world);
        pluginRun(pointGrid);
    };
    const bxFn = (i: number) => {
        if (i % INTERVAL === 0) boundsGrid.onTick(world);
        pluginRun(boundsGrid);
    };
    // Prime both, then measure in an A/B/B/A order and keep the min of each, so
    // process warmup (which favours whichever runs later) cancels out.
    const pt1 = measure(TICKS, ptFn);
    const bx1 = measure(TICKS, bxFn);
    const bx2 = measure(TICKS, bxFn);
    const pt2 = measure(TICKS, ptFn);
    const ptMs = Math.min(pt1, pt2);
    const bxMs = Math.min(bx1, bx2);
    console.log(`${'grid-pt'.padEnd(8)} ${ptMs.toFixed(4)} ms/op`);
    console.log(`${'grid-bx'.padEnd(8)} ${bxMs.toFixed(4)} ms/op`);
    pluginMs = bxMs;
    aoi = boundsGrid;
} else {
    pluginMs = run('grid', TICKS, (i) => {
        if (i % INTERVAL === 0) aoi.onTick(world);
        pluginRun(aoi);
    });
}

// --- full server tick ---------------------------------------------------------
const loop = new GameLoop({ type: 'manual-server', tickRate: TICK_RATE });
const transport = new SinkServer();
const server = new GameServer({
    world,
    loop,
    transport,
    protocol: { intents: defineIntents({}), rpcs: defineRpcs({}) },
    snapshot: { rate: TICK_RATE },
});
server.use(aoi);

let connected = 0;
server.on('connection', ({ peer }) => {
    server.assignEntity(peer, players[connected++]!);
});
for (let p = 0; p < PEERS; p++) transport.addPeer(`p${p}`);

let tick = 1;
const fullMs = run('full', TICKS, () => {
    tick++;
    advance(tick);
    loop.step(1 / TICK_RATE);
});

console.log(
    `\ngrid is ${(pluginMs / fullMs * 100).toFixed(0)}% of the full tick ` +
        `(the rest is the core: candidate/interest passes + encode)\n`,
);

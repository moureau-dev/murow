/**
 * LagCompensation benchmark — run with:
 *
 *   bun run packages/netcode/bench/lag-compensation.ts
 *
 * Env knobs:
 *   ENTITIES  (default 1000)
 *   TICKS     (default 2000)
 *   REWINDS   (default 2000)
 *   LABEL     (free-form tag printed with the results)
 *
 * Reports time/op plus heap growth (no-GC churn and retained-after-GC).
 */
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World, type Entity } from 'murow/ecs';
import { networked } from '../src/components/sync-spec';
import { LagCompensation } from '../src/server/plugins/lag-compensation';

const ENTITIES = Number(process.env.ENTITIES ?? 1000);
const TICKS = Number(process.env.TICKS ?? 2000);
const REWINDS = Number(process.env.REWINDS ?? 2000);
const LABEL = process.env.LABEL ?? 'run';
const TICK_RATE = 20;

const Position = defineComponent('Position', {
    schema: { x: f32, y: f32, z: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});
const Rotation = defineComponent('Rotation', {
    schema: { x: f32, y: f32, z: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

function makeWorld(maxEntities: number): World {
    return new World({ maxEntities, components: [Position, Rotation] });
}

/** Mutate every entity and mark both components dirty, as systems would. */
function advance(world: World, ids: Entity[], tick: number): void {
    const p = world.fields(Position);
    const r = world.fields(Rotation);
    for (let i = 0; i < ids.length; i++) {
        const e = ids[i];
        p.x[e] = tick;
        p.y[e] = i;
        p.z[e] = tick * 0.5;
        r.x[e] = i * 0.01;
        r.y[e] = tick;
        r.z[e] = i;
        world.markDirty(e, Position.__worldIndex!);
        world.markDirty(e, Rotation.__worldIndex!);
    }
}

interface Sample {
    msPerOp: number;
    churnKB: number;
    retainedKB: number;
}

function run(label: string, iters: number, fn: (i: number) => void): Sample {
    // Warm up the JIT so we time steady-state, not first-call deopt.
    for (let i = 0; i < Math.min(iters, 200); i++) fn(i);

    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = performance.now();
    const after = process.memoryUsage().heapUsed;
    Bun.gc(true);
    const afterGc = process.memoryUsage().heapUsed;

    const msPerOp = (t1 - t0) / iters;
    const churnKB = (after - before) / 1024;
    const retainedKB = (afterGc - before) / 1024;
    console.log(
        `${label.padEnd(10)} ${msPerOp.toFixed(4)} ms/op   ` +
            `churn +${churnKB.toFixed(1)} KB   retained +${retainedKB.toFixed(1)} KB`,
    );
    return { msPerOp, churnKB, retainedKB };
}

console.log(
    `\n[${LABEL}] entities=${ENTITIES} ticks=${TICKS} rewinds=${REWINDS} tickRate=${TICK_RATE}\n`,
);

const world = makeWorld(ENTITIES);
const ids: Entity[] = [];
for (let i = 0; i < ENTITIES; i++) {
    const e = world.spawn();
    world.add(e, Position, { x: 0, y: 0, z: 0 });
    world.add(e, Rotation, { x: 0, y: 0, z: 0 });
    ids.push(e);
}

const plugin = new LagCompensation({
    tickRate: TICK_RATE,
    historyMs: 500,
    components: [Position, Rotation],
});
plugin.onMount({ world } as any);

let tick = 0;
let rewindTick = 0;

run('tick', TICKS, () => {
    tick++;
    advance(world, ids, tick);
    plugin.onTick(world, 1 / TICK_RATE);
    world.clearAllDirty();
});

// Keep the history warm so rewind always finds a frame.
for (let i = 0; i < 20; i++) {
    tick++;
    advance(world, ids, tick);
    plugin.onTick(world, 1 / TICK_RATE);
    world.clearAllDirty();
}

run('rewind', REWINDS, () => {
    rewindTick++;
    const target = tick - (rewindTick % 10) - 1;
    plugin.rewind(target, () => {
        // A realistic handler body: touch one entity's rewound state.
        const p = world.fields(Position);
        return p.x[ids[0]];
    });
});

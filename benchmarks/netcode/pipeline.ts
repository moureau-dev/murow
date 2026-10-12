/**
 * Snapshot pipeline benchmark — server encode -> client decode -> interpolation.
 * Run with:
 *
 *   bun run benchmarks/netcode/pipeline.ts
 *
 * Env knobs:
 *   ENTITIES  (default 500)
 *   ITERS     (default 3000)
 *   LABEL     (free-form tag printed with the results)
 *
 * Reports throughput per phase and the *analytical* allocation model, because
 * Bun (1.4.x) does not expose a usable allocation counter: `process.memoryUsage`
 * does not track JS objects (500k retained objects move `heapUsed` by 0) and
 * `Bun.gc`'s return value is a constant unrelated to allocation volume.
 *
 * Allocation model per snapshot, N entities with P present components each:
 *   encode  0 objects      (reused SnapshotEncoder buffer + reused mask buffer)
 *   decode  0 objects once the pool is warm (Map + rows + value objects recycled;
 *           only a transient local-entity-id array is allocated)
 *   interp  0 objects      (reused scratch; apply writes into the world)
 */
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World, type Entity } from 'murow/ecs';
import { networked } from '../../packages/netcode/src/components/sync-spec';
import {
    SnapshotEncoder,
    buildDeltaSchema,
    decodeDelta,
} from '../../packages/netcode/src/codec/delta-codec';
import { ServerEntityMap } from '../../packages/netcode/src/client/server-entity-map';
import { SnapshotInterpolation } from '../../packages/netcode/src/client/strategies/interpolation/interpolation';
import { SnapshotPool } from '../../packages/netcode/src/codec/snapshot-pool';

const ENTITIES = Number(process.env.ENTITIES ?? 500);
const ITERS = Number(process.env.ITERS ?? 3000);
const LABEL = process.env.LABEL ?? 'run';

const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});
const Rotation = defineComponent('Rotation', {
    schema: { x: f32, y: f32, z: f32, w: f32 },
    sync: networked({ rate: 'every-tick', interest: 'global', interp: 'slerp' }),
});
const COMPONENTS = [Position, Rotation];

function run(label: string, iters: number, fn: (i: number) => void): void {
    for (let i = 0; i < Math.min(iters, 200); i++) fn(i); // warm up JIT
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = performance.now();
    const msPerOp = (t1 - t0) / iters;
    console.log(
        `${label.padEnd(10)} ${msPerOp.toFixed(4)} ms/op   ${(1000 / msPerOp).toFixed(0)} ops/s`,
    );
}

console.log(`\n[${LABEL}] entities=${ENTITIES} iters=${ITERS}\n`);

const serverWorld = new World({ maxEntities: ENTITIES, components: COMPONENTS });
const clientWorld = new World({ maxEntities: ENTITIES, components: COMPONENTS });
const serverToLocal = new ServerEntityMap(ENTITIES);
const ids: Entity[] = [];
for (let i = 0; i < ENTITIES; i++) {
    const se = serverWorld.spawn();
    serverWorld.add(se, Position, { x: 0, y: 0 });
    serverWorld.add(se, Rotation, { x: 0, y: 0, z: 0, w: 1 });
    ids.push(se);

    const ce = clientWorld.spawn();
    clientWorld.add(ce, Position, { x: 0, y: 0 });
    clientWorld.add(ce, Rotation, { x: 0, y: 0, z: 0, w: 1 });
    serverToLocal.set(se, ce);
}

const encoder = new SnapshotEncoder(buildDeltaSchema(serverWorld, COMPONENTS, 1));

function advance(tick: number): void {
    const p = serverWorld.fields(Position);
    const r = serverWorld.fields(Rotation);
    for (let i = 0; i < ids.length; i++) {
        const e = ids[i]!;
        p.x[e] = tick * 0.1;
        p.y[e] = i;
        r.x[e] = 0;
        r.y[e] = 0;
        r.z[e] = tick * 0.01;
        r.w[e] = 1;
        serverWorld.markDirty(e, Position.__worldIndex!);
        serverWorld.markDirty(e, Rotation.__worldIndex!);
    }
}

let tick = 0;
let frame: Uint8Array = new Uint8Array(0);
const pool = new SnapshotPool();
const encode = (): void => {
    tick++;
    advance(tick);
    frame = encoder.encode(serverWorld, tick, ids, [], 0);
    serverWorld.clearAllDirty();
};
run('encode', ITERS, encode);

const payload = (): Uint8Array => frame.subarray(1);
const ensure = (serverEid: number): number => serverToLocal.get(serverEid)!;
const decode = (): void => {
    decodeDelta(clientWorld, payload(), COMPONENTS, 1, ensure, undefined, pool);
};
run('decode', ITERS, decode);

const interp = new SnapshotInterpolation(serverToLocal, 16, 100, 300, undefined, 0, undefined, pool);
let now = 0;
const entityIds = ids;
const interpFn = (): void => {
    now += 16;
    interp.record({
        receivedAt: now,
        serverTick: tick,
        entityIds,
        componentValuesByEntity: new Map([[ids[0]!, [{ x: 1, y: 2 }, { x: 0, y: 0, z: 0, w: 1 }]]]),
    });
    interp.apply(clientWorld, now, COMPONENTS, () => false);
};
run('interp', ITERS, interpFn);

const P = COMPONENTS.length;
console.log(
    `\nalloc model (objects/snapshot): encode 0   decode 0 (pooled; ~${9 + ENTITIES * (1 + P)} cold)   interp 0\n`,
);

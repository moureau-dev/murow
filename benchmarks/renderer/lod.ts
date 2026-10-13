/**
 * LOD CPU cost — the new per-frame work `selectLod` adds, plus spawn-time chain
 * building. Run with:
 *
 *   bun run benchmarks/renderer/lod.ts
 *
 * Env: N (instances, default 10000), LOD (fraction with a chain, default 1.0),
 *      ITERS (default 2000).
 *
 * Allocation note: Bun's memory APIs don't track JS objects, so this measures
 * time only. `selectLod` is allocation-free in steady state (it iterates the
 * dense lodSlots set and only touches the batcher on a change); chain building
 * allocates, but only at spawn.
 */
import { InstanceStore } from '../../packages/murow/src/renderer/managers/runtime/instances/instance-store';
import type { ModelHandle } from '../../packages/murow/src/renderer/managers/runtime/types/types';

const N = Number(process.env.N ?? 10_000);
const LOD = Number(process.env.LOD ?? 1.0);
const ITERS = Number(process.env.ITERS ?? 2_000);

const base: ModelHandle = { id: 7, vertexCount: 3, indexCount: 0, skinned: false };

function run(label: string, iters: number, fn: (i: number) => void): void {
    for (let i = 0; i < Math.min(iters, 200); i++) fn(i);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = performance.now();
    const ms = (t1 - t0) / iters;
    console.log(`${label.padEnd(26)} ${ms.toFixed(5)} ms/op   ${(1000 / ms).toFixed(0)} ops/s`);
}

function build(withLod: boolean): InstanceStore {
    const s = new InstanceStore({ maxInstances: N, getTextureBindGroup: () => undefined });
    for (let i = 0; i < N; i++) {
        const h = s.spawn(
            { prefab: base, position: [(i % 120) * 4, 0, ((i / 120) | 0) * 4] },
            base, null, i + 1,
        );
        if (withLod && i / N < LOD) {
            s.setLodLevels({ slot: h.slot, modelIds: [7, 8, 9], distSq: [2500, 10_000, Infinity] });
        }
    }
    return s;
}

function median(v: number[]): number {
    v.sort((a, b) => a - b);
    return v[(v.length / 2) | 0]!;
}

// --- spawn cost (chain building) ---
function timeBuild(withLod: boolean): void {
    const runs: number[] = [];
    for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        build(withLod);
        runs.push(performance.now() - t0);
    }
    console.log(`build N ${withLod ? '(LOD)  ' : '(no LOD)'} ${median(runs).toFixed(2)} ms total   ${(median(runs) / N * 1000).toFixed(3)} µs/instance`);
}

console.log(`\nN=${N}  LOD=${LOD}  ITERS=${ITERS}\n`);

const withLod = build(true);
const noLod = build(false);

let camX = 0;
run('selectLod (no LOD chains)', ITERS, () => noLod.selectLod(camX, 0, 0));
run('selectLod (static cam)', ITERS, () => withLod.selectLod(camX, 0, 0));
run('selectLod (moving cam)', ITERS, () => { camX += 0.5; withLod.selectLod(camX, 0, 0); });
console.log('');
timeBuild(false);
timeBuild(true);
console.log('');

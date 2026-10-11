/**
 * WebGPU implementation of the renderer's `Particles3D` port.
 *
 * Owns the particle simulation kernels (spawn / integrate / compact / args) so
 * the renderer never sees a builder or a kernel. A non-compute backend would
 * implement the same port with a CPU simulation.
 */
import type { ParticleSimulation, Particles3D } from 'murow/renderer/managers/runtime';
import { Particle3D, ComputeFrame, DrawArgs } from 'murow/renderer/managers/runtime';
import { d, std } from './gpu';
import { ComputeBuilder } from './compute/compute-builder';

/** Build a `Particles3D` port backed by WebGPU compute kernels. */
export function createParticles3d(): Particles3D {
    return {
        createSimulation(o): ParticleSimulation {
            const root = o.root;

            const spawn = new ComputeBuilder('particles-spawn', { workgroupSize: 64 }, root as never)
                .buffers({
                    particles: { storage: d.arrayOf(Particle3D, o.max), readwrite: true, external: o.pool as never },
                    spawnRecords: { storage: d.arrayOf(Particle3D, o.maxSpawns), external: o.spawns as never },
                    frame: { uniform: ComputeFrame, external: o.frame as never },
                })
                .shader(({ globalId }, { buffers }: any) => {
                    'use gpu';
                    const { particles, spawnRecords } = buffers;
                    const frame = buffers.frame as any;
                    const i = globalId.x;
                    if (i >= frame.counts.y) { return; }
                    // @ts-ignore — TGSL uniform struct access
                    const slot = (frame.counts.x + i) & frame.counts.w;
                    const src = spawnRecords[i];
                    particles[slot].px = src.px;
                    particles[slot].py = src.py;
                    particles[slot].pz = src.pz;
                    particles[slot].vx = src.vx;
                    particles[slot].vy = src.vy;
                    particles[slot].vz = src.vz;
                    particles[slot].age = src.age;
                    particles[slot].life = src.life;
                    particles[slot].size = src.size;
                    particles[slot].r = src.r;
                    particles[slot].g = src.g;
                    particles[slot].b = src.b;
                    particles[slot].a = src.a;
                    particles[slot].gx = src.gx;
                    particles[slot].gy = src.gy;
                    particles[slot].gz = src.gz;
                    particles[slot].mat = src.mat;
                    particles[slot].grow = src.grow;
                    particles[slot].rot = src.rot;
                    particles[slot].spin = src.spin;
                    particles[slot].turb = src.turb;
                })
                .build();

            const integrate = new ComputeBuilder('particles-integrate', { workgroupSize: 64 }, root as never)
                .buffers({
                    particles: { storage: d.arrayOf(Particle3D, o.max), readwrite: true, external: o.pool as never },
                    frame: { uniform: ComputeFrame, external: o.frame as never },
                })
                .shader(({ globalId }, { buffers }: any) => {
                    'use gpu';
                    const { particles, frame } = buffers;
                    const i = globalId.x;
                    const p = particles[i];
                    if (p.life <= 0.0) { return; }
                    // @ts-ignore — TGSL uniform struct access
                    const dt = frame.params.x;
                    // @ts-ignore — TGSL uniform struct access
                    const drag = frame.params.z;
                    // @ts-ignore — TGSL uniform struct access
                    const time = frame.params.y;
                    const tv = p.turb * dt;
                    const vx = (p.vx + p.gx * dt) * drag + std.sin(p.py * 2.1 + time * 0.9) * tv;
                    const vy = (p.vy + p.gy * dt) * drag + std.sin(p.pz * 2.3 - time * 0.7) * tv;
                    const vz = (p.vz + p.gz * dt) * drag + std.sin(p.px * 2.0 + time * 1.1) * tv;
                    const age = p.age + dt;
                    particles[i].px = p.px + vx * dt;
                    particles[i].py = p.py + vy * dt;
                    particles[i].pz = p.pz + vz * dt;
                    particles[i].vx = vx;
                    particles[i].vy = vy;
                    particles[i].vz = vz;
                    particles[i].age = age;
                    if (age >= p.life) { particles[i].life = -1.0; }
                })
                .build();

            const compact = new ComputeBuilder('particles-compact', { workgroupSize: 64 }, root as never)
                .buffers({
                    particles: { storage: d.arrayOf(Particle3D, o.max), external: o.pool as never },
                    counts: { storage: d.arrayOf(d.atomic(d.u32), o.maxMaterials), readwrite: true, external: o.counts as never },
                    indices: { storage: d.arrayOf(d.u32, o.maxMaterials * o.max), readwrite: true, external: o.indices as never },
                    frame: { uniform: ComputeFrame, external: o.frame as never },
                })
                .shader(({ globalId }, { buffers }: any) => {
                    'use gpu';
                    const { particles, counts, indices, frame } = buffers;
                    const i = globalId.x;
                    const p = particles[i];
                    if (p.life <= 0.0) { return; }
                    // @ts-ignore — TGSL uniform struct access
                    const mat = d.u32(p.mat);
                    // @ts-ignore — atomic on a storage array element
                    const slot = std.atomicAdd(counts[mat], d.u32(1));
                    // @ts-ignore — TGSL uniform struct access
                    indices[mat * frame.counts.z + slot] = i;
                })
                .build();

            const args = new ComputeBuilder('particles-args', { workgroupSize: o.maxMaterials }, root as never)
                .buffers({
                    counts: { storage: d.arrayOf(d.atomic(d.u32), o.maxMaterials), readwrite: true, external: o.counts as never },
                    args: { storage: d.arrayOf(DrawArgs, o.maxMaterials), readwrite: true, external: o.args as never },
                    frame: { uniform: ComputeFrame, external: o.frame as never },
                })
                .shader(({ globalId }, { buffers }: any) => {
                    'use gpu';
                    const { counts, args, frame } = buffers;
                    const m = globalId.x;
                    void frame;
                    // @ts-ignore — atomic on a storage array element
                    args[m].vertexCount = d.u32(4);
                    // @ts-ignore — atomic on a storage array element
                    args[m].instanceCount = std.atomicLoad(counts[m]);
                    args[m].firstVertex = d.u32(0);
                    args[m].firstInstance = d.u32(0);
                })
                .build();

            return {
                encodeSpawn: (encoder, count) => spawn.encode(encoder as never, count),
                encodeIntegrate: (encoder, count) => integrate.encode(encoder as never, count),
                encodeCompact: (encoder, count) => compact.encode(encoder as never, count),
                encodeArgs: (encoder, count) => args.encode(encoder as never, count),
                destroy: () => {
                    spawn.destroy();
                    integrate.destroy();
                    compact.destroy();
                    args.destroy();
                },
            };
        },
    };
}

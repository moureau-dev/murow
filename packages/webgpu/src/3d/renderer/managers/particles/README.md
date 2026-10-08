# 3D particles

`ParticleSystem3D` — the GPU-first particle system behind `renderer.particles`.

- The CPU only queues **spawn records**; the GPU spawns into a power-of-two ring pool, integrates every particle in compute (gravity, drag, turbulence), and draws instanced camera-facing quads batched **per material** via a compaction pass + `drawIndirect`.
- `addEmitter(options)` returns a live `ParticleEmitter3D`. `emitter.update(dt)` queues that emitter's spawns; the renderer calls `simulate(dt)` once per frame (spawn + integrate + compact + args).
- Materials: `{ texture?, blend: 'additive' | 'alpha', atlas?: { cols, rows, fps } }`. No texture renders a soft procedural disc.
- Kernels live in `particle-system-3d.ts` (spawn, integrate, compact, args); the billboard vertex/fragment are authored declaratively with TypeGPU. `shaders.ts` only holds the shared stride constants.

Capacity and quality:

- Renderer options: `maxParticles`, `maxSpawnsPerFrame`, `maxParticleMaterials`, `maxParticleEmitters`.
- Runtime: `renderer.particles.rateScale` (0 stops spawning) and `sizeScale`.

# Performance and frame budget in murow

murow's frame is split into a fixed-rate simulation and a display-rate render, and the renderer already does most of the per-frame culling, batching, and caching for you. This guide is the practical reference for spending the remaining frame budget: which levers actually move the needle, what the engine handles automatically, and which optimisations you must design around because they do not exist yet.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **Cap the resolution first.** `maxPixelRatio` (default uncapped) is the single cheapest large win on HiDPI — scene, post, and shadows all scale with it. On 3D renderers only.
2. **Keep `tickRate` low and let the GPU interpolate.** 15–30 Hz simulation renders smoothly at refresh via `mix(prev, curr, alpha)` in the vertex shader. Do not set 60 Hz "for smoothness".
3. **Instance the same prefab.** 3D batches one draw call per `(model, material)` pair; every extra material on a model is another batch and another draw.
4. **Batch 2D by sheet.** Sprites are bucketed by `(layer, spritesheet)` — 10k sprites across one sheet is one draw call. Wrong sheet choice is the usual 2D cost.
5. **Budget shadows.** The sun's map is cached and re-rendered only on change; spot (≤4) and point (≤2) maps re-render every frame. Disable unused shadow systems.
6. **Every camera effect is a fullscreen pass.** A non-empty `camera.effects` chain forces the off-screen path; each enabled effect is one ping-pong pass over the capped resolution.
7. **Keep the hot path zero-GC.** Read the [zero-allocation guide](./zero-allocation.md) before writing per-frame systems; no `world.get`/`world.update` in hot loops.
8. **Design around the gaps.** No occlusion culling, no LOD, no user GPU-driven/indirect path, no shadow cascades, no compressed textures. Cull and simplify yourself where they matter.

## The model

### What the renderer does automatically

You get these for free as long as you call `storePreviousState()` in `pre-tick` and `render(alpha)` in `render`:

| Feature | What it does |
|---|---|
| GPU frame interpolation (lerp) | `mix(prev, curr, alpha)` runs in the vertex shader. Low tick rates look smooth at high refresh. |
| Frustum culling | 3D: a per-instance bounding-sphere test against the camera frustum; off-screen instances are excluded from the batch before upload. |
| Distance-based animation culling | 3D: CPU skinning is skipped past `animationCullDistance` (default 50). Bone math is the biggest glTF cost, so this is the largest crowd-scene win. |
| Instanced / skinned batching | 3D: instances are bucketed by `(material, model)` and drawn in one call per visible batch. |
| Sparse-batched draw calls | 2D: sprites bucketed by `(layer, spritesheet)`, one call per bucket. |
| Instance recycling | `handle.destroy()` returns the slot and bone-matrix block to a free list; respawns reuse buffers. |
| Shadow-map caching | The directional map re-renders only when the sun, the snapped shadow box, or a caster changes (version counters); a static scene reuses the previous map. |
| Particle emitter culling | 3D particles set the camera frustum each frame, so an off-screen emitter spawns nothing (live particles still finish). |

### The frame-budget levers

**Resolution cap.** `new WebGPU3DRenderer(canvas, { maxPixelRatio: 1.5 })`. Default is uncapped, meaning `devicePixelRatio` can be 2–3 on HiDPI. This is 3D-only; the 2D renderer sizes to `devicePixelRatio` with no cap option.

**Simulation rate.** `new GameLoop({ tickRate: 20 })`. `tickRate` is the simulation rate, not the render rate; the client renders at refresh and interpolates. Higher tick rate costs CPU and, in multiplayer, bandwidth for no visual gain. Keep server and client rates equal when predictions are in use.

**Draw-call budget.** 2D costs one call per spritesheet bucket; keep sprites on the right sheet and layer. 3D costs one call per visible `(model, material)` batch, so material count multiplies the budget: prefer one material per model where possible, and use `materials: [...]` only when you need it (up to 4).

**Instancing vs decals vs particles vs `GeometryBuilder`.** All four are instanced paths; pick by update pattern:

- Ordinary meshes: `renderer.instances` (one draw per batch, transforms via the handle).
- Surface marks (blood, scorch, AoE): `renderer.decals.createLayer(...)` — one draw call for the whole pool, fade computed in the shader, no CPU expiry.
- 3D effects: `renderer.particles` — GPU-first, per-material compaction and `drawIndirect`, emitter-frustum culling.
- Fully custom per-instance data/shader: `renderer.geometry.create(...)` / `GeometryBuilder`, with `.fromBuffer(buffer)` for zero-copy external storage buffers.

**`SparseBatcher`.** Two integer keys → dense `Uint32Array` buckets, allocated lazily. The 2D and 3D renderers use it internally (`(layer, sheet)` and `(material, model)`); reuse it for your own two-key grouping (a spatial grid `(cellX, cellZ)` → entities) so you never build a `Map<key, array>` per frame.

**Shadow cost.** Directional (sun): cached, cheap if the scene is static — tune `renderer.shadows.directional.distance` and `.resolution`, and disable via `.enabled`. Spot (≤4/frame) and point (≤2/frame) maps re-render every frame: only set `castShadow: true` when the light earns it, and gate the systems with `renderer.shadows.spot` / `.point` `.enabled`. Per material, `shadow: { cast, receive }`.

**Camera-effect cost.** Each enabled entry in `renderer.camera.effects` is one fullscreen pass through two off-screen targets. `motionBlur` accumulates temporally; `fxaa`/`fog` sample more bindings. Keep the chain short, disable rather than remove while iterating, and remember all passes scale with `maxPixelRatio`.

### Zero-GC hot path and the ECS performance model

The data path is allocation-free: `Float32Array` buffers, `FreeList`/`PooledCollection` slots, reused query arrays. The full toolkit is in the [zero-allocation guide](./zero-allocation.md) — the short version for performance:

- Components are typed binary schemas stored **SoA** (one `Float32Array` per field), so field iteration is cache-friendly.
- `world.fields(C)` returns a precisely-typed bundle resolved once — the recommended hand-written pattern, ~1.3x slower than RAW `getFieldArray` hoisting and reliably faster than the system-builder tiers.
- `world.query(...)` returns a **reused, cached** array rebuilt only on archetype changes (spawn/despawn/add/remove), matched via cached **bitmasks** (32 components per mask word, unrolled for 1–4 words). Safe to iterate; never retain across structural edits.
- Avoid `world.get`/`world.update` (the Direct tier, ~6x slower than RAW) in per-frame loops.

Benchmarked against bitECS and Bevy, Murow's tail latency is its strength: at 100k entities bitECS shows ~45x max/P50 GC spikes (a single ~350 ms frame) while Murow stays ~1.6–1.8x. A steady shorter frame beats an averagey one with stalls.

### 2D vs 3D

- **2D** — the unit of cost is the `(layer, spritesheet)` bucket. Put all sprites that share a sheet on the same sheet and layer for one draw call. For thousands of sprites in a hot system, write to `SpriteAccessor` directly (the raw façade `SpriteHandle` wraps) to avoid per-sprite ergonomics.
- **3D** — the unit of cost is the visible `(model, material)` batch, plus skinning for animated meshes (culled by distance) and shadow passes. Fewer distinct models/materials on screen means fewer draws.

## Worked examples

### Cap resolution and decouple the tick rate

```ts
const renderer = new WebGPU3DRenderer(canvas, {
  assets,
  maxInstances: 5000,
  maxPixelRatio: 1.5,          // cap internal resolution on HiDPI
  animationCullDistance: 15,   // skip skinning past 15 units
});

const loop = new GameLoop({ type: 'client', tickRate: 20 });  // sim at 20 Hz
loop.on('pre-tick', () => renderer.storePreviousState());      // capture prev transforms
loop.on('render', ({ alpha }) => renderer.render(alpha));      // render at refresh
```

### Keep the 3D batch count low

```ts
const mat = renderer.materials.create({ name: 'crate', type: 'standard', textures: { map: 'wood' } });
for (let i = 0; i < 500; i++) {
  renderer.instances.add({ prefab: crates, position: [i % 25, 0, (i / 25) | 0], material: mat });
}
// 500 instances of one model + one material = one visible batch, one draw call.
// Adding a second material to each crate would double the batch count.
```

### Use the right effect path per job

```ts
// pooled surface marks: one draw for the whole pool, shader-side fade
const decals = renderer.decals.createLayer({ atlas: 'decals', quad: 'decalQuad', capacity: 128, cols: 4, rows: 4, life: 8 });
decals.add(x, y, z, nx, ny, nz, { cell: 1, size: 0.6 });

// GPU particles: per-material indirect batching + emitter culling
const fire = renderer.particles.addEmitter({ position: [x, y, z], rate: 120, material: { texture: 'spark', blend: 'additive' } });
renderer.particles.update(deltaTime);
```

### Budget the shadow systems

```ts
renderer.shadows.directional.distance = 40;   // shrink the ortho box for crisper, cheaper coverage
renderer.shadows.spot.enabled = false;        // spot maps re-render every frame — only enable what earns it
renderer.shadows.point.enabled = false;
```

## Gaps to design around

These do not exist in the current renderer; assume them and compensate in game code:

- **No occlusion culling.** Frustum culling only removes off-screen instances. Geometry hidden behind walls still draws. Avoid dense overlapping interiors; split or stream large occluded regions yourself.
- **No LOD.** Every visible instance draws its full mesh (skinned meshes share bone math but not a reduced mesh). Keep crowd meshes low-poly, or swap prefabs by distance manually.
- **No GPU-driven / indirect path for user geometry.** Particles use indirect batching internally, but there is no public API to drive arbitrary geometry from GPU-side culling/compaction. `GeometryBuilder.fromBuffer` is zero-copy, not GPU-driven.
- **Single directional shadow box, no cascades.** One fixed box around the camera (`renderer.shadows.directional.distance`); casters beyond it do not cast and detail falls off with distance. There is no cascade split, so wide outdoor ranges will alias or drop shadows.
- **No compressed textures.** Textures upload as decoded images and get a mip chain; there is no KTX/Basis/ASTC path. Large texture sets pay full VRAM, so budget texture memory yourself.

## Gotchas

- **`maxPixelRatio` is 3D-only.** The 2D renderer has no resolution cap; it sizes to `devicePixelRatio`.
- **A non-empty effect chain forces off-screen rendering.** Even one effect switches to the ping-pong path. Remove effects you no longer need instead of leaving them disabled long-term if you want the direct path back.
- **Material count is a draw-call multiplier in 3D.** `materials: [...]` draws the instance once per material. Use one material per model on the hot path.
- **Spot and point shadows are per-frame.** Only the directional map is cached. A "static" scene with moving spot lights still pays a shadow pass every frame.
- **`tickRate` affects bandwidth, not just CPU.** In multiplayer it drives snapshot cadence; keep server and client rates equal when predicting.
- **The ECS query array is reused.** Iterate it immediately; re-query after any structural change so you don't read a stale batch list.
- **`world.fields` bypasses dirty tracking.** In netcode use `ctx.fields(C)` (auto-marks dirty); a missed mark silently drops the write from snapshots, not just from performance.

## Quick reference

| lever | where | effect |
|---|---|---|
| `maxPixelRatio` | 3D renderer options | caps internal resolution (scene + post + shadows); cheapest large win |
| `tickRate` | `GameLoop` options | simulation rate; rendering interpolates the rest |
| draw-call budget | model/material spread (3D), sheet/layer (2D) | 3D: one call per visible `(model, material)`; 2D: one per `(layer, sheet)` |
| `renderer.instances` | 3D meshes | instanced transforms, per-batch draws, frustum culling |
| `renderer.decals` | 3D surface marks | one draw for the whole pool, shader-side fade |
| `renderer.particles` | 3D effects | GPU-indirect per material, emitter frustum culling |
| `GeometryBuilder` / `renderer.geometry` | custom instanced geometry | custom layouts, `.fromBuffer` zero-copy |
| `SparseBatcher` | custom batching | two-key dense bucketing, no per-frame `Map` |
| `renderer.shadows.directional` | sun shadows | cached; tune `.enabled`/`.distance`/`.resolution` |
| `renderer.shadows.spot` / `.point` | dynamic shadows | re-render every frame; enable sparingly |
| `renderer.camera.effects` | post chain | one fullscreen pass per enabled effect |
| `world.fields` / `world.query` | ECS hot loops | SoA typed arrays, cached bitmask queries |
| `SpriteAccessor` | 2D hot systems | raw zero-alloc writes for thousands of sprites |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



# TODO: murow open work

Every item was checked against the source on 2026-11-24. Citations use repo
paths. `RT/` is `packages/murow/src/renderer/managers/runtime/`, `NC/` is
`packages/netcode/src/`, and `M/` is `packages/murow/src/`. Importance and
difficulty run from 1 to 10. Difficulty is effort: 10 is a subsystem, 1 is
trivial. Done work is listed at the bottom so it is not reopened.

## Order of work

1. Silent data corruption and crashes in core: H1, H2, H3, H44, H19, H23, H33.
2. Docs that teach those bugs or show code that throws (DOC1, DOC2).
3. A CI workflow that runs build, typecheck, and tests on push (CI1), then the
   visual gate (R2).
4. The remaining hardening items, then features.

## Renderer

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| R1 | No WebGL2 backend. Mobile and system-WebView packaging stay blocked. | Only `packages/webgpu` exists. `M/renderer` and `M/gpu` are backend-agnostic; the seam is real. | 9 | 9 |
| R2 | No visual verification gate. | No script runs typecheck, tests, and a render on a real GPU, failing on console errors, a blank canvas, or the wrong backend. Headless Chromium on a GPU-less host returns a blank canvas, so this needs a GPU runner. Depends on CI1. | 7 | 5 |
| R3 | Camera effects only work on full-screen views. | `docs/renderer.md:368`. Partial views skip the off-screen effect path. | 5 | 4 |
| R4 | LOD is primary-only. | `docs/renderer.md:368`. One LOD selection for the current primary camera. | 4 | 5 |
| R5 | Occlusion culling only runs with one view. | `docs/renderer.md:368`. Multi-view needs a per-view HZB policy. | 4 | 7 |
| R6 | No per-camera or per-layer shadow mask. Directional, spot, and point shadows exist, and per-material `shadow.cast`/`receive` is toggleable at runtime, but a viewmodel or scope camera cannot have its own shadow policy. The directional box is fitted around the primary camera. | `RT/shadows/shadow-system.ts:222-269`; `RT/materials/material-library.ts:251-255,279,309`. | 5 | 6 |
| R7 | LDR-only environment: no HDR or float path and no exposure control. | `docs/renderer.md:998`. Skybox and IBL share one LDR equirect. | 5 | 5 |
| R9 | `maxCameras` bounds the registry only; per-view GPU resources are not preallocated. | `llms.txt:1427`. | 2 | 3 |
| R10 | 2D depth-based effects use a 1x1 fallback depth target, so `fog` does nothing. | `docs/renderer.md:637`. | 3 | 3 |
| R11 | No multi-camera examples or docs for split-screen, minimap, and FPS viewmodel or scope masking. | No example creates a second camera. | 5 | 3 |
| R12 | No transparent sorting. Opaque and transparent are two passes, but batches keep model and material order. | `RT/internals/main-pass/main-pass.ts:26-36`. `docs/renderer.md:717` refers to a "mesh transparent-sorting pass" that does not exist. | 5 | 5 |
| R13 | No in-engine text or UI renderer. | No font or glyph code in `M/renderer` or `packages/webgpu`. `murow/dom` overlays cover HUD and nameplates only. | 6 | 6 |
| R14 | No advanced post effects: SSAO, SSR, TAA, DOF, volumetric light, or outline. | `RT/cameras/camera-effect.ts:17-39` lists vignette, grade, grayscale, chromatic, scanlines, posterize, motion blur, FXAA, fog, bloom, and custom shaders. | 5 | 7 |
| R15 | No per-instance 3D visibility. | `InstanceHandle` has no `enabled`; `RT/instances/instance-store.ts:91,113,123` uses flag bits only for occlusion and occluder. Hiding needs destroy and re-add, scale 0, or a material swap. | 5 | 2 |
| R16 | No shadow cascades. | No `cascade` symbol anywhere; `RT/shadows/shadow-system.ts` builds one ortho box. Wide outdoor views alias or lose casters. | 6 | 6 |
| R17 | Model ID ceiling: 64 unique models per renderer, and `ModelLibrary` throws past it. Blocks large character rosters, per-chunk terrain, and preloading large worlds. | `MAX_SHEETS = 64` at `M/core/sparse-batcher/sparse-batcher.ts:16`; throws at `RT/internals/model-library/model-library.ts:237,353`. `MAX_LAYERS = 256` (`:14`), so 4096 sheets means about 1M buckets and about 12 MB of `bucketSizes`/`activeBuckets`/`sortBuffer` per batcher, with one batcher per instance store plus sprites. The `Uint16Array`s at `:22-23` must widen. `MAX_SHEETS` is also read by `sheets.ts`, `shadows.ts`, and `instances.ts`. Interacts with H23. | 7 | 6 |
| R18 | No cloth, hair, or subsurface material presets. Only `standard`, `pbr`, `unlit`, `emissive`, and custom `shader`. | `RT/materials/material-library.ts` built-ins. | 3 | 5 |

### Renderer plans

- **R1 WebGL2:** start with a reduced backend, not parity: instanced meshes,
  PBR and unlit, sprites, shadows, and the post chain. Put compute skinning,
  GPU particles, and occlusion behind capabilities. The shared renderer is
  shaped around storage buffers and compute, so add a second
  instanced-attribute path and CPU or vertex fallbacks.
- **R2 Visual gate:** typecheck, tests, then render a known scene on a real
  GPU. Assert non-blank pixels, no console errors, and the requested backend.
- **R3 Per-camera effects:** give each camera its own off-screen target and
  resolve pass instead of requiring a full-screen rect.
- **R4/R5 Per-view LOD and occlusion:** extend the per-view cull with a policy
  object; keep primary-only as the default.
- **R6 Shadow masks:** separate `casterMask` and `receiveMask` from
  `camera.mask`. Add per-camera shadow focus only if a game needs it.
- **R11 Examples:** split-screen with two masks, a minimap inset excluding UI
  and viewmodel, and an FPS scope or viewmodel setup. These double as docs and
  tests.
- **R15 Instance visibility:** add an `enabled` flag to the instance slot and
  skip disabled slots during culling and batching.
- **R16 Cascades:** split the directional ortho box into 2 to 4 cascades with
  per-cascade resolution and a stable snap, keeping the single box as an
  option.
- **R17 Model cap:** make `MAX_SHEETS` configurable, size batcher arrays from
  the actual sheet and layer counts instead of the maximums, and audit every
  `key / MAX_SHEETS` decode. Fix H23 first.
- **R18 Material presets:** optional `cloth`, `hair`, and `subsurface` shader
  templates on the existing `shader` material path.

## Assets

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| A1 | No asset streaming or eviction. `Bucket.add` throws after `load()`, `init()` uploads the whole bucket and sizes `maxInstances` from it, and nothing unloads or refcounts. Models are reclaimed only by `renderer.destroy()`. Textures are never freed: `TextureRegistry` has no destroy, and `renderer.destroy()` does not release them. | `M/core/bucket/bucket.ts:73`; `packages/webgpu/src/runtime/renderer/renderer-3d.ts:219-220,344,826-837`; `RT/models/models.ts:91`; `RT/internals/model-library/model-library.ts:83`; `RT/internals/texture-registry/texture-registry.ts`. | 8 | 8 |
| A2 | No GPU-compressed textures (KTX2, Basis, ASTC) or mesh compression (Draco, meshopt). Textures upload as decoded RGBA, and the glTF parser has no extension handling. | `RT/internals/texture-registry/texture-registry.ts:74` always uses `rgba8unorm`; `M/renderer/gltf/parser.ts:105`. | 8 | 6 |
| A3 | `AssetBucket.prefabs()` assigns the callback's return value to the live bucket; a block body sets it to `undefined` and `load()` throws. `textures()` ignores the return. The proxy at `:146` still reads the original bucket. `bucket.get('typo')` compiles, because `StringOr` accepts any string, while docs call it a compile error. | `M/renderer/buckets/asset/asset.ts:119,137,146`; `M/core/bucket/bucket.ts:13-14,22,142`. | 4 | 2 |

### Assets plans

- **A1:** per-prefab and per-texture refcounts with an unload path on the model
  and texture managers; let `AssetBucket` register prefabs after `load()`, or
  add a second bucket per region. Keep whole-bucket preload as the default.
  Release textures in `renderer.destroy()` regardless.
- **A2:** decode KTX2 or Basis to a supported GPU format with an RGBA fallback,
  and wire Draco and meshopt into the glTF parser behind a capability check.
- **A3:** ignore the `prefabs()` callback return, as `textures()` does, or
  validate it and fall back to the original. Fix the docs and the
  `bucket.ts` JSDoc: unknown ids autocomplete-miss and throw at runtime.

## Levels and asset lifetime

Orchestration on top of A1. A level is a bookkeeping scope over one renderer,
not a new renderer and not a scene graph. See R17 for the per-level model
ceiling and A3 for the bucket callback fix.

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| L1 | No level or resource scope: no refcounted acquire and release, no per-level handle tracking, and no guaranteed destroy-before-free ordering. | Handles live in global pools. A `LevelScope` would wrap prefab lookup, tracked instances, lights, emitters, decals, ribbons, and VFX, plus `dispose()`. | 7 | 5 |
| L2 | `AssetBucket` cannot load subsets: `Bucket.load()` loads everything pending and freezes. No `ensure(ids)`, `isLoaded(id)`, or `freeze()`. Internals use `Map` and `Set`. | `M/core/bucket/bucket.ts:55-57,104-138`. | 7 | 4 |
| L3 | No way to upload bucket prefabs after init, and no per-model or per-texture free. Post-init model upload already exists (`loadModel`, `loadGltf`, `uploadParsedGltf`, `createX`), and `TextureRegistry.upload(prefab)` is per texture. | `RT/internals/model-library/model-library.ts:83,127-156,420`; `RT/internals/texture-registry/texture-registry.ts:67`. Overlaps A1. | 8 | 5 |
| L4 | No eviction policy or preload: no refcounts, leases, pins, LRU or budget, or in-flight cancellation. | Refcounts must cover the dependency closure (textures, LOD levels, composite parts, skins). Safe to evict means count 0, not loading, not pinned, and all handles destroyed. The only refcounts today are for materials and bone blocks. | 7 | 7 |
| L5 | No typed level definitions or manager. | `defineLevels({...})` with `const` generics so `load(id)` is `keyof D`; `new LevelManager({ renderer, assets, definitions, maxLoaded, evict })`. A sibling system, not a renderer type parameter. | 5 | 4 |

### Levels plans

- **L1:** `LevelScope` as a thin proxy: a `prefab(id)` view, auto-tracked
  `instances`, `lights`, `emitters`, `decals`, and `ribbons`, optional
  `vfx.spawn`, and `dispose()` that destroys handles first, then releases
  assets.
- **L2:** add `Bucket.ensure(ids)`, `isLoaded(id)`, `freeze()`, `pendingCount`,
  and `loadedCount`; `load()` becomes `ensure(all pending)` plus `freeze()`.
  Track `New | Pending | Loading | Loaded | Error` in a `Uint8Array` and dedupe
  in-flight loads in a slot-indexed `Promise[]`, with a sorted id index and
  binary search instead of `Map` and `Set`. Keep `size` as the registered
  total. Do not add `unload` to `AssetBucket` beyond dropping parsed CPU data.
- **L3:** `models.uploadPrefab(prefab)` and `textures.upload(prefab)` after
  init, and `free(id)` for eviction. Recycle IDs in a later phase.
- **L4:** `acquire(id)` increments synchronously and returns `ready`; release
  at zero; evict only refcount-0 unpinned resources. `preload` takes a pin;
  `unload` releases the scope.
- **L5:** `defineLevels` and `LevelManager` with `load`, `show`, `preload`,
  `unload`, `maxLoaded` (LRU or throw), events (`loaded`, `unloaded`,
  `evicted`, `error`), and stats. Keep gameplay, World, audio, and UI out of
  the scope.

Stages: 1) one active level, free GPU buffers, no ID recycling; 2) shared-asset
refcounts, LRU, and preload; 3) ID recycling, async cancellation, and streaming
budgets. Do R2 before shipping any of it.

## VFX

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| V5 | 3D particles are camera-facing quads with texture, blend, and atlas only: no mesh or stretched billboards, soft depth fade, collision, sub-emitters, bursts, colour or alpha curves, box, cylinder, or edge emitter shapes, lighting, or custom shaders. Turbulence, a cone (`spawnRadius`) shape, and a linear `grow` size ramp exist. Drag is fixed. | `RT/particles/3d/particle-system-3d.ts:606` hardcodes `0.985`. | 7 | 7 |
| V6 | Decals are unlit atlas quads. They fade over a per-layer `life`, but have no per-decal tint or fade, no normal or roughness, and no animated flipbooks. | `RT/decals/decal-material.ts:45`. | 4 | 4 |
| V7 | No debug draw or gizmo layer beyond hitbox debug. `renderer.ribbons.addLine` works as a stopgap for lines. | `HitboxDebugRenderer` at `RT/hitbox/hitbox.ts:91` is the only one. | 5 | 3 |
| V8 | No VFX composition layer. Effects are assembled by hand from particles, decals, ribbons, and lights; no declarative bundles, timelines, attachment, pooling, or budgets. | No VFX manager in `RT/`. | 4 | 4 |

### VFX plans

Do R2 first. Keep spawning on the CPU and simulation on the GPU.

- **V5a Cheap:** bursts (`emitter.burst(n)`), per-emitter drag, over-life
  colour, alpha, and size curves through a 1D LUT, and box, cylinder, and edge
  emitter shapes. CPU spawn records plus one fragment LUT.
- **V5b Quality:** soft depth fade (bind the opaque depth, fade by depth
  delta), stretched billboards (orient the quad along velocity), and lit
  particles (ambient and sun first, nearest N lights later).
- **V5c Authoring:** custom particle shaders through `GpuShader` with
  per-material uniforms and textures.
- **V5d Complex:** sub-emitters (a GPU death-event buffer plus a second spawn
  dispatch, or async readback), mesh particles, and depth or SDF collision.
- **V8:** a sibling system like `AudioManager`, generic over the effect map:
  `defineVfx({...})` plus `new VfxManager(renderer, { effects, audio? })`,
  stepped from `tick`. Composes primitives; does not own audio or gameplay.

## Terrain and environment

Only worth building for outdoor, strategy, survival, racing, or open-world
targets. Zone-based and isometric games can stay on authored meshes.

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| T1 | No heightfield: no height or normal queries, analytic raycast, heightmap import, chunked LOD mesh, splat layers, or runtime painting. | No heightfield or terrain code in `packages/murow` or `packages/webgpu`; `AssetBucket` has no heightmap parser. MVP: a pure-CPU `Heightfield` (typed arrays, `heightAt`, `normalAt`, `raycast`), chunked shared LOD meshes with GPU displacement or a dedicated pass, a 4-layer splat shader, and offline import. | 6 | 5 |
| T2 | No terrain streaming or eviction, shadow and HZB integration, or authoring. | Depends on A1. A dedicated pass must join the shadow pass and HZB; clipmap seams and brush tooling are extra. | 5 | 8 |
| T3 | No water, baked lightmaps or GI, or reflection probes. | Only PBR, IBL, and custom shaders. | 4 | 7 |

### Terrain plans

- **T1:** keep `Heightfield` pure CPU and renderer-agnostic so the server can
  run height and line-of-sight queries. Render chunks as shared LOD templates
  with vertex height displacement, or use a dedicated manager when per-chunk
  bounds and eviction are needed. Mind R17.
- **T2:** budgeted load and unload with `R_load > R_keep` hysteresis, per-chunk
  CPU bounds, shadow and HZB participation, and clipmap seam handling. Evict by
  age, distance, and memory pressure, not by occlusion alone.
- **T3:** a planar or cubemap water shader, baked lightmaps or vertex-colour
  lighting, and optional reflection probes.

## 2D

The 2D core has instanced sprites, a zero-GC `SpriteAccessor`, GPU
interpolation, layers, custom geometry, 2D raycast and hitboxes, NavMesh and
Crowd, 2D audio, and netcode. These gaps block larger 2D games.

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| D1 | No sprite frustum culling. Every sprite in a visible layer is packed and drawn, even off-screen. | `RT/sprites/sprites.ts:153-173` (`prepareFrame`) only tests `visibleTo` against the camera mask. | 8 | 3 |
| D2 | No per-sprite depth or Y-sort. Draw order is the `(layer, sheet)` bucket, then insertion order. Sort layers are capped at 256 and are a separate axis from the 32 render layers. | `RT/sprites/sprite-accessor.ts` has no depth field; `M/core/sparse-batcher/sparse-batcher.ts:14,41` keys by `layer * MAX_SHEETS + sheet`. | 7 | 4 |
| D3 | No tilemap: no tileset, Tiled import, chunked tile rendering, autotiling, or tile collision. | No tilemap code anywhere. | 7 | 6 |
| D4 | No 2D lighting or shadows. Sprites are unlit. | No lights manager in `packages/webgpu/src/runtime/renderer/renderer-2d.ts`; the sprite shader is a fixed unlit path. | 7 | 7 |
| D5 | No 2D skeletal animation (Spine, DragonBones). | Only the spritesheet `AnimationController`. | 6 | 6 |
| D6 | 2D particles are CPU-driven and basic; no 2D decals or trails. | `RT/particles/2d/emitter.ts:35-46`: rate, gravity, fade, one frame. Decals and ribbons are 3D only. | 5 | 4 |
| D7 | No pixel-perfect mode, no per-sheet filter control, no 2D `maxPixelRatio`. | `RT/sheets/sheets.ts:55-57` hardcodes `nearest`; `maxPixelRatio` is wired only in 3D (`renderer-3d.ts:385`). | 5 | 2 |
| D8 | No 9-slice, parallax helper, or per-sprite custom shader. | Sprites expose tint, UV, opacity, and flip; `renderer.geometry` covers custom shaders but not `sprites`. | 4 | 3 |
| D9 | Stale 2D and 3D source comments: the 2D header advertises `renderer.compute` and "TypeGPU"; `maxCameras` says "Defaults to 4" while the code uses 2; the 3D header claims back-face culling. | `packages/webgpu/src/runtime/renderer/renderer-2d.ts:2,7,12,59,107`; `renderer-3d.ts:2,8`; `RT/types/types.ts:140`. | 2 | 1 |
| D10 | Setting `SpriteAccessor.layer` at runtime does not move the sprite to the new bucket, so draw order does not change. | `RT/sprites/sprite-accessor.ts:110`. | 5 | 2 |

Related: in-engine text is R13, camera effects on partial views are R3, and the
2D fog no-op is R10.

### 2D plans

- **D1:** a per-camera world-bounds test in `prepareFrame` using each sprite's
  transform and size, writing the existing slot-index buffer. For very large
  scenes, bucket sprites in a `SpatialGrid` and iterate candidate cells.
- **D2:** a depth field or packed `sortKey` in the sprite layout, sorted inside
  each `(layer, sheet)` bucket. Keep `layer` as the coarse band so the batch
  count stays low.
- **D3:** `Tilemap` as data (tileset plus chunked tile arrays) that emits sprite
  or geometry instances; parse Tiled JSON; expose collision layers to
  `NavMesh` and hitboxes. Reuse D1 for chunk culling.
- **D4:** a 2D light manager (point, spot, directional), a normal-mapped sprite
  variant, and a light pass; optional 2D occluders and shadows. Mind R7.
- **D5:** a Spine or DragonBones parser and 2D skinning runtime, or document it
  as a game-side integration.
- **D6:** bring 2D particles to V5a parity and add 2D decals and trails on the
  same batch.
- **D7:** an integer-zoom pixel-perfect camera mode, a per-sheet
  `filter: 'nearest' | 'linear'`, and a `maxPixelRatio` option for 2D.
- **D8:** 9-slice sprites, a parallax layer helper, and a sprite shader override
  that falls back to the current fast path.
- **D10:** re-bucket on layer change, the same way `remove` plus `add` would.

## Audio

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| AU1 | No playback rate or pitch on `SourceHandle` or `AudioOutput`, so engine RPM, doppler, and pitch-shifted one-shots cannot be expressed. | No rate, pitch, or detune anywhere in `M/core/audio`; `M/core/audio/sources/web-audio.ts:142` never sets `playbackRate`. | 5 | 3 |

## Netcode

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| N6 | No reliable snapshot delivery: no ack, resend, or baseline on loss. | `NC/client/game-client.ts` has only KickAck and SyncAck; baselines are sent only on join and reconnect. | 4 | 8 |
| N7 | No derived-state strategy. | `NC/client/strategies/config.ts` ships `snapshot-interpolation`, `extrapolation`, and `hybrid`. | 3 | 3 |

### Netcode plans

- **N6:** add `CMSG_SNAPSHOT_ACK`, keep a short dirty-delta history, resend
  after the last acked tick, and fall back to a full baseline when the gap is
  too large. Trigger: a UDP or WebTransport transport. WebSocket already orders
  and delivers snapshots, so this waits until then.
- **N7:** a `DerivedStrategy` that records authoritative inputs and calls a user
  `derive(world, deltaMs)` on sync and tick, registered as a `'derived'` kind
  with typed options. Type checking stops at the app-typed callback.

## Product and DX

- **CI1: no test workflow.** The only workflow is `publish.yml`, so nothing runs
  build, typecheck, or tests on push or on pull requests. Importance 8,
  difficulty 2.
- **Physics:** no collision or rigid-body engine.
- **Packaging and scaffolding:** see Scaffolding.
- **Profiler:** no frame profiler or GPU timer view. Debug draw is V7.
- **Voice:** no mic capture, Opus encode, transport, jitter buffer, or
  spatialised playback. Best as an optional WebRTC and Opus adapter over
  `AudioManager`, not core; the game owns channels, push-to-talk, and
  moderation.
- **VR/XR:** no WebXR session, stereo or multiview rendering, or render-rate
  pose prediction and late latching. The injectable `InputEventSource` covers
  controller events only; VR needs an XR subsystem sampled at render rate,
  decoupled from the 15–45 Hz tick, plus full-body IK.

## Scaffolding (`create-murow`)

The repo has examples but no generator and no template matrix. A newcomer must
copy an example and wire the build by hand.

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| SC1 | No scaffolding CLI (`npx create-murow`, `bun create murow`). | `packages/` holds only murow, webgpu, netcode, and website. | 7 | 5 |
| SC2 | No template matrix: singleplayer browser, multiplayer browser and server, zero-build CDN HTML, Neutralino desktop. | Only `examples/multiplayer-cube-arena` uses netcode. `bouncing-sprites` and `bouncing-3d` are single-player and use Pixi.js and pex; `multiplayer-snake` has no networking. None are parameterised or tested as templates. | 7 | 4 |
| SC3 | No Neutralino desktop packaging (Windows, macOS, Linux). | `neutralino` appears nowhere. Needs `neutralino.config.json`, dev and build scripts, per-OS artifacts, and a binary distribution path. | 5 | 5 |
| SC4 | No zero-build CDN template. The documented jsDelivr imports are a snippet, and they pin 0.1.8 while the package is at 0.4.1. | `docs/assets.md:143-151`; `llms.txt:190-199`. | 5 | 2 |
| SC5 | Templates would be untested. Generated projects must typecheck, build, and smoke-run in CI. | Depends on CI1; the browser case depends on R2. | 6 | 4 |
| SC6 | No per-template quickstart docs, and nothing explains desktop versus mobile packaging. | `README.md` has no packaging section. Neutralino covers desktop and supports WebGPU on Windows, macOS, and Linux; mobile is a separate path (Capacitor or Cordova) and needs R1. | 4 | 2 |

### Scaffolding plans

- **SC1:** a separate `create-murow` package, also reachable as
  `bun create murow`. Prompt for project name, template, netcode on or off, and
  tick rate; generate into a new directory; print the install and dev
  commands. Keep it dependency-light so `npx` is fast.
- **SC2:** templates under `packages/create-murow/templates/<name>/`:
  `singleplayer-browser` (GameLoop and WebGPU, no netcode, no ECS by default),
  `multiplayer-browser` (the `shared/`, server, and client layout from
  `multiplayer-cube-arena`), `cdn-html` (SC4), and `desktop-neutralino` (SC3).
  Each ships its own tests and README.
- **SC3:** Neutralino wraps the built client. Ship `neutralino.config.json`,
  `desktop:dev` and `desktop:build` scripts, and per-OS release artifacts. The
  desktop template can use the WebGPU renderer directly.
- **SC4:** a single `index.html` using the two jsDelivr URLs
  (`murow@<version>/+esm` and `.../dist/webgpu/esm/murow.webgpu.bundle.js`)
  with an import map and a small scene, plus a version-bump script so the pin
  tracks releases.
- **SC5:** CI generates every template, runs `tsc --noEmit`, the template
  build, and a headless deterministic tick test; browser templates also run
  the R2 gate.
- **SC6:** one quickstart per template, a comparison table (singleplayer and
  multiplayer; browser, desktop, and CDN), and a packaging note that separates
  desktop from mobile.

## Hardening: source audit findings

Correctness and robustness gaps found by reading and running the source. Items
marked ✓ were reproduced with a script against the repo source. Write a failing
test before fixing each one.

### ECS / core

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H1 | Registering a component in a second `World` corrupts the first world's store indices, because `__worldIndex` lives on the shared component object. `EntityHandle` also caches `__cachedIndex` and `__fieldCache_*` on the component, so a handle in one world can read another world's values. Client and server worlds in one process (the testing setup) hit this. | `M/ecs/components/component-manager.ts:55`; `M/ecs/entity/entity-handle.ts:94-140`. ✓ | 8 | 4 |
| H2 | The SoA store picks typed arrays by byte size only: `i8` and `i16` read back unsigned, `f16` truncates, `f64` gets one byte per entity, and `bool` returns `0`/`1`. `world.fields()` reports `Int8Array` but returns `Uint8Array`. | `M/ecs/components/component-store.ts:47-68`. ✓ | 8 | 4 |
| H3 | Despawning or removing components while iterating a system or `world.query()` skips entities (swap-pop over the live cache with a cached length). The ECS README recommends this pattern, and the hybrid and ergonomic benchmarks use it. | `M/ecs/world/systems.ts:356,361`; `M/ecs/query/query-manager.ts:179-189`. ✓ | 8 | 3 |
| H4 | `EntityHandle` writes (`update`, `set`, `setField`, `setFields`) bypass dirty tracking and `isAlive`. Batch state is `static`, so it is shared across all handles. `beginUpdate` only queues `setField`. | `M/ecs/entity/entity-handle.ts:45-52,258-390`. | 6 | 3 |
| H5 | `DespawnTracker` is fixed at `maxEntities` and silently drops despawns under churn. | `M/ecs/trackers/despawn-tracker.ts:13-19`. | 6 | 2 |
| H6 | `SimpleRNG.rand()` can return exactly 1, so `int(min, max)` can return `max + 1` and `pick` can return `undefined`. Seed 653637408 reproduces it. | `M/core/simple-rng/simple-rng.ts:20-22,36`. ✓ | 5 | 1 |
| H7 | `EventSystem` breaks under nested emits and throwing callbacks: a single `emitting` index, no `try/finally`. A nested emit followed by `off`/`once` skips listeners. | `M/core/events/event-system.ts:27,92-102`. ✓ | 6 | 2 |
| H8 | `PooledCodec`: the encode buffer is fixed at 1024 bytes with no option to change it; encoded buffers are never returned to the pool, so every encode allocates; releasing a short subarray poisons the pool; `decodeInto` allocates per field; nested plain objects and nested codecs as fields are not handled, so the README example throws. | `M/core/pooled-codec/pooled-codec.ts:122-152,197,232,261,138`. ✓ | 6 | 4 |
| H9 | `FreeList.free` accepts double frees and out-of-range indices (it throws only when the pool is already full), so an index can be handed out twice. Docs and `llms.txt:1002` say it throws. `Ring` with `capacity: 0` does nothing. | `M/core/free-list/free-list.ts:34-40`; `M/core/ring/ring.ts:21`. ✓ | 4 | 1 |
| H10 | `FixedTicker` never stores `onTickSkipped`, so `GameLoop`'s `skip` event never fires. Skipped ticks stay in the accumulator, so sustained overload builds a backlog. `alpha` can go negative. Changing `rate` leaves derived fields stale. | `M/core/fixed-ticker/fixed-ticker.ts:58-66,75-98,150`; `M/game/loop/loop.ts:118-119`. ✓ | 6 | 2 |
| H44 | `World.despawn` returns the id to the free ring immediately. The next `spawn()` reuses it while it is still listed in `getDespawned()`. Docs say despawn is deferred until flush. | `M/ecs/entity/entity-manager.ts:66-74`; `M/ecs/world/world.ts:107-112`; `M/ecs/trackers/despawn-tracker.ts:25`. ✓ | 7 | 3 |

### Protocol / netcode

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H12 | Protocol and netcode schema fingerprints hash field byte size, not type (`f32` and `i32` match). The netcode sort makes component order irrelevant. | `M/protocol/define-protocol.ts:82-86`; `NC/codec/fingerprint.ts:21-38`. | 5 | 3 |
| H13 | `SnapshotRegistry` u8 type ids wrap at 256; `RpcRegistry` u16 ids wrap at 65536. Cap or widen. | `M/protocol/snapshot/snapshot-registry.ts:93,125`; `M/protocol/rpc/rpc-registry.ts:89`. | 6 | 2 |
| H14 | A reordered stale snapshot can resurrect a despawned entity: `decodeDelta` and `ensureEntity` run before the `tick <= lastReconciled` guard, and `lastServerTick` can go backwards. Latent: every shipped transport is an ordered WebSocket. | `NC/client/game-client.ts:452-500`. | 3 | 4 |
| H15 | Global dirty clear with no per-peer resend: an `on-change` entity that re-enters a peer's interest without being dirty is never re-sent. The packet-loss half is latent on WebSocket. | `NC/server/game-server.ts:503-512,623-636,695-700`. | 8 | 7 |
| H16 | Removing a synced component is not replicated; clients keep it forever. | `NC/codec/delta-codec.ts:308-336`. | 7 | 4 |
| H17 | Lag compensation records dirty entities only, so a rewind omits entities that did not move on that tick. Carry state forward or record every configured entity each tick. | `NC/server/plugins/lag-compensation.ts:121-197`. | 7 | 4 |
| H18 | No client/server tick sync. Lag compensation rewinds by the client's `intent.tick` against its own server tick count and falls back to the nearest record. `ctx.tick` differs between client and server. The prediction RNG seed uses each side's own entity id, so `ctx.rng` differs whenever the ids differ; the test passes only because both are 0. Docs recommend `ctx.tick` in predictions and imply `ctx.rng` matches. | `NC/server/game-server.ts:849-865`; `NC/client/game-client.ts:304,308,604-625`; `NC/prediction-seed.ts:21-35`; `NC/server/plugins/lag-compensation.ts:124,135,225-245`; `NC/packets/rng.test.ts:81`. | 8 | 6 |
| H19 | A throwing intent handler propagates out of `drainIntentQueues` and the `pre-tick` emit, aborting the whole server tick and leaving `EventSystem.emitting` stuck (H7). A rejected intent does not undo its prediction. Async handlers never report an outcome. | `NC/server/game-server.ts:388-390,433,868-878`. | 9 | 3 |
| H20 | Reconnect leaks stale client entities: `resetBaseline` does not clear `serverToLocal`, and despawns that happened while away are never sent. The 250 ms resume window loses slow links. Wire ids have no generation, so id reuse aliases old mappings. | `NC/server/game-server.ts:303-339`; `NC/client/game-client.ts:376-384,676-683`; `NC/client/server-entity-map.ts`. | 6 | 6 |
| H21 | Unknown interest plugin names admit everything, so a typo leaks data. AOI `hysteresisRadius` is added to both enter and leave, so it is not hysteresis. A peer with no assigned entity sees everything under `AoiGrid`. | `NC/server/game-server.ts:685-689`; `NC/server/plugins/aoi-grid.ts:124,153-154,170,195-196,224-228`. | 5 | 2 |
| H22 | The browser pre-open queue does not copy send buffers (violates the transport contract). The Bun client drops sends before OPEN and has no `onOpen`, so `GameClient` never fires `connected` and never resumes a session over it. The virtual transport's disconnect does nothing. | `M/net/adapters/browser-websocket.ts:61`; `M/net/adapters/bun-websocket.ts:8-40`; `M/net/adapters/virtual-network.ts:197`. | 5 | 2 |
| H45 | `client.use(plugin)` accepts only predictions and silently ignores a `ClientPlugin`; no client plugin hook ever runs. `docs/netcode.md:716-725` documents it. | `NC/client/game-client.ts:561-568`; `NC/server/plugins/plugin.ts:48`. | 5 | 3 |

### Renderer / WebGPU

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H23 | Multi-material instances corrupt `SparseBatcher`: one bucket per slot, and `remove` ignores its key arguments, so extra materials draw or remove the wrong batch. Destroyed instances keep drawing. | `M/core/sparse-batcher/sparse-batcher.ts:27-100`; `RT/instances/instance-store.ts:174-191,355-366`. ✓ | 8 | 4 |
| H24 | LOD geomorph is not implemented: `positionB` and `morphVertexBuffer` are bound but never read; only a dither crossfade exists. The comment at `renderer-3d.ts:341` repeats the claim. | `RT/shader/shader.ts:38,226,350,461`; `RT/internals/main-pass/main-pass.ts:46-88`. | 5 | 3 |
| H25 | The LOD companion slot leaks when the main instance is destroyed (`lod.clear` drops `fadeCompanion` without `endCompanion`). | `RT/instances/instance-store.ts:355-376,482-494`; `RT/instances/lod-store.ts:74-81`. | 5 | 2 |
| H26 | Occlusion `bias` is never uploaded (written to a separate f32 array); static compaction writes in place in the same buffer (a race); the rotated AABB ignores rotation. Occlusion is off unless the `occlusion` option is passed, while the webgpu README and `llms.txt` say it is on by default. | `packages/webgpu/src/compute/occlusion.ts:106-107,303,333-335`; `RT/instances/instances.ts:370-372`; `renderer-3d.ts:266`. | 6 | 4 |
| H28 | The skinned bone-offset allocator advances by `2 * jointCount`, leaving half of each block unread, with no check against `maxTotalBones`. | `RT/instances/skinned-instance-store.ts:263-270`. | 6 | 3 |
| H29 | Negative scale gives a negative bounding radius in non-skinned culling and shadow gathering (missing `Math.abs`). | `RT/instances/instances.ts:351-354`; `RT/shadows/shadows.ts:147`. | 5 | 1 |
| H30 | Skeletal, particle, and ribbon simulation runs in `render` on `performance.now()`. Cosmetic unless gameplay reads bone poses. | `packages/webgpu/src/runtime/renderer/renderer-3d.ts:527-541,707-717`. | 3 | 4 |
| H31 | glTF: normalized integer attributes are converted raw; the index type is chosen by index count, not by the largest index; matrix-authored joints get a TRS stub; ancestor node transforms are ignored. | `M/renderer/gltf/helpers.ts:146-162`; `M/renderer/gltf/skin-parser.ts:296`; `M/renderer/gltf/parser.ts:197-206`. | 6 | 5 |
| H32 | Setting the spot shadow resolution leaves the targets at the old size while the shader's texel size changes. The material slot leaks when creation throws. Removed custom camera effects keep their buffers until the id is reused. | `RT/shadows/spot-shadow-system.ts:101`; `RT/shadows/shadows.ts:216`; `RT/materials/material-library.ts:209`; `RT/camera-effects/camera-effects.ts:186`. | 4 | 3 |
| H46 | Instance handle setters (`setPosition`, `setRotation`, `setScale`) write the slot without checking that the handle is still alive, so a stale handle moves whatever reuses the slot. `docs/renderer.md:12,47` say stale handles are inert. | `RT/instances/instance-store.ts:274-300`. | 6 | 2 |
| H50 | Sphere prefabs are always unit radius: `SphereSpec` has no `radius` or size option, and the parser drops unknown keys without a warning. The live demos at murow-pbr.basebox.site pass `radius` from plain JavaScript and get spheres of radius 1. `renderer.shadows.directional.anchorStep` is also assigned by those demos but exists only on the internal `ShadowSystem`, so it does nothing. | `M/renderer/buckets/prefab/utility/specs.ts:141-148`; `M/renderer/buckets/prefab/utility/parsers.ts:175-184`; `RT/shadows/shadows.ts:51-90`; `RT/shadows/shadow-system.ts:79`. | 4 | 2 |
| H47 | `maxSpawnsPerFrame` is documented as a renderer option but is not forwarded, so it is fixed at 512. | `RT/particles/3d/particle-system-3d.ts:236`; `M/renderer/managers/3d.ts`. | 2 | 1 |

### Shader DSL (`murow/gpu`)

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H33 | The emitter produces invalid or wrong WGSL: mutable locals are declared with `let` and repaired by a `let`→`var` regex with no word boundary; a ternary emits `select` with the condition first; `continue` in `for` or `do` skips the update (an infinite loop on the GPU); `0.0` bundled to `0` becomes an `i32` local. Validate emitted WGSL with Tint or Naga in CI. | `M/gpu/compiler/parse.ts:392-560`; `packages/webgpu/src/gpu/backend/backend.ts:89-95`. ✓ | 8 | 6 |
| H34 | The eager DSL (`shader.fragment`) executes the body, so native operators on `ShaderValue` produce `NaN`; integer vector constructors carry float schema fields; std140 array stride is not rounded to 16 bytes. The engine uses `GpuShader` only, so the eager path could be removed or limited to tests. | `M/gpu/dsl/entry.ts:61`; `M/gpu/dsl/data.ts:285-294`; `M/gpu/schema/align.ts:43-45`. | 5 | 5 |

### Spatial / navmesh / hitbox

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H35 | Out-of-bounds grid queries iterate the unclamped cell range, which can be huge. Rebuilds are lazy and allocate only on growth. | `M/core/spatial/grid-core.ts:104-208`. | 5 | 2 |
| H36 | Quadtree and Octree entries outside the root sink into edge children and can disappear from queries after subdivision. The JSDoc says they are tested at the root. | `M/core/spatial/tree-core.ts:152-263`; `quadtree.ts:3`; `octree.ts:3`. ✓ | 5 | 3 |
| H37 | NavMesh workers are broken: `'auto'` never engages; obstacle changes never reach workers; calls before pool init reject; the pool's init and terminate paths leave promises hanging. `Crowd` on a worker navmesh discards the path promise every tick, so agents never move. Grid A* has no search bound. Rotated rectangles are indexed by their unrotated AABB. | `M/core/navmesh/navmesh.ts:461-475,583-630,933-1055`; `M/core/navmesh/navmesh-worker-pool.ts:69-220`; `M/core/crowd/crowd.ts:231-237`. | 7 | 6 |
| H38 | 2D hitbox part offsets are not rotated, so parts on rotated sprites are misplaced. | `M/core/hitbox/test.ts:111-117`. | 5 | 2 |

### Audio / input / DOM

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H39 | A later `fade()` does not cancel a pending `stopAfter`, so the source is freed anyway. `stopAfter` counts down in `update(dt)` while the ramp runs in audio time. | `M/core/audio/manager.ts:311-317,400-410`; `M/core/audio/sources/web-audio.ts:402-407`. | 5 | 2 |
| H40 | `pointerup` is bound only to the element, so buttons stick when released off-canvas. Pointer coordinates use the event target's rect, which breaks with nested DOM. | `M/core/input/sources/browser.ts:21-25`; `M/core/input/manager.ts:134-156`. | 5 | 2 |
| H41 | Recycled DOM overlay nodes keep classes, styles, and listeners set on the element itself. `spawn()` clears the clone's children, so structured templates lose their content and the documented `querySelector` examples get `null`. A `transition` forces a synchronous reflow per node. | `M/dom/html-dom.ts:195-205,344`. | 5 | 2 |
| H48 | Non-looping `play()` sources are never freed when the clip ends; the slot stays until `stop()`. When every live source is music, `play` throws "maxSources reached". | `M/core/audio/manager.ts:252-256,487-498`. | 5 | 2 |

### Packaging

| # | Gap | Evidence / notes | Importance | Difficulty |
|---|---|---|---|---|
| H43 | Deep subpath exports are inconsistent: `./core/*` and `./gpu/*` map to a folder `index`, while `./ecs/*`, `./game/*`, `./protocol/*`, and `./renderer/*` map to `*.js`, so `murow/ecs/world` and `murow/game/loop` do not resolve. | `packages/murow/package.json` `exports`. ✓ | 4 | 2 |
| H49 | The publish workflow's `workflow_dispatch` `ref` input is never passed to the checkout step, so a manual run publishes the default branch. `bun run test --bail` passes `--bail` to `concurrently`, which ignores it. | `.github/workflows/publish.yml`. | 4 | 1 |

## Documentation

A full read of every Markdown file and `llms.txt` against the source found
roughly 350 wrong or stale claims. AGENTS.md and the `murow/gpu` READMEs are
fixed. The examples folder is out of scope for now.

| # | Gap | Where | Importance | Difficulty |
|---|---|---|---|---|
| DOC1 | Examples that throw or do not compile. Shader materials pass `fragment: fn` (the code requires `{ fn }`). `loop.on(...)` should be `loop.events.on`. `defineComponent(name, { schema })` without `sync` throws. The `PooledCodec` and `HTMLDom` template examples throw. The root README GPU compute example uses `renderer.createCompute`, which does not exist. `llms.txt` imports cameras and handles from `murow/webgpu`, which exports only `d`, `std`, `runtime`, the two renderers, and `OcclusionTrackerImpl`. | renderer.md, shaders.md, webgpu README, determinism.md, performance.md, zero-allocation.md, testing.md, ui.md, dom README, pooled-codec README, root README, llms.txt | 9 | 3 |
| DOC2 | Docs that teach bugs: despawn inside a system (H3); "despawn is deferred" (H44); i8, i16, f16, f64, and bool fields as supported (H2); `ctx.tick` in predictions and `ctx.rng` as identical on both sides (H18); `rngSeed` undocumented. | ECS README, docs/ecs.md, zero-allocation.md, determinism.md, netcode.md, netcode README | 9 | 2 |
| DOC3 | Removed or non-existent APIs still documented: `IntentTracker` and `Reconciliator` (now `PredictionLog` and `Reconciler`); the `ServerNetwork` RPC API (`client.sendRpc(Def)`, `onRpc`, `sendRpcBroadcast`); `IntentRegistry.register(kind, codec)` and `decode(kind, buf)`; `murow/net/ecs`; `PooledArrayEncoder`; `createDriver('server')`; `Vector2` from `murow/core/input`; `assets.audio`; `renderer.shadows.directional.anchorStep`; `renderer.particles.removeEmitter`. | llms.txt, murow README, protocol README, define-rpc JSDoc, net README, driver README, renderer.md | 8 | 3 |
| DOC4 | Whole files that need a rewrite: `protocol/README.md` (removed stack); `packages/webgpu/README.md` (seven of 14 source links are dead, no PBR, IBL, skybox, ribbons, layers, or LOD); `packages/website/README.md` (template boilerplate); `packages/website/docs/NEWSTACK.md` (imports `"newstack"`, behind the installed version); 23 of 27 `core/*` READMEs have wrong or missing API details. | as listed | 6 | 5 |
| DOC5 | False performance claims: blanket "zero allocation" (`query()`, `entity()`, `setFields`, navmesh, encode, and `Ray.at` all allocate); stale benchmark numbers and a wrong Bevy variance claim in the ECS README; "Fields 1.3x slower than RAW". | ECS README, murow README, performance.md, navmesh README, ray README | 5 | 2 |
| DOC6 | Stale or contradictory small claims: the 0.1.8 CDN pin; occlusion "on by default"; `bucket.get('typo')` "compile error"; `TexturePrefab` as `ImageBitmap`; "back-face culling by default"; the renderer README "no GPU API" line; the minification guidance in `llms.txt` and the README against the parser that accepts minifier folds; `SlewClock` "holds steady". | llms.txt, assets.md, renderer README, webgpu README, clock README, source JSDoc | 4 | 2 |

## Game rewrite feasibility (post-TODO)

Premises: every item above is implemented, art, content, and tooling are
excluded, npm composition is allowed, the tick is 15–45 Hz, and scale is per
match or per server, not a live-ops fleet. "1:1" means reproducing the
mechanics, netcode, and rendering behaviour, not the original content. The
percentages are judgement, not measurement. Replay, spectator, anti-cheat,
matchmaking, and console certification are not covered and not assumed.

| Game | Genre | Est. feasibility | Main engine blockers |
|---|---|---|---|
| League of Legends | Isometric MOBA | ~90% | Fog and team vision as a custom interest plugin; replay, spectator, and anti-cheat are out of scope. Tick (~30) fits. |
| Dota 2 | MOBA | ~90% | Same as LoL plus dynamic obstacles (trees) and navmesh (H37). |
| Trine trilogy | 2.5D physics platformer | ~90% | Physics via npm with local substeps; 2.5D rendering and multi-camera local co-op fit; online co-op fits the netcode. |
| Orcs Must Die | Third-person action, tower defense | ~85% | Physics traps and ragdolls via npm; crowd and instancing cover horde density. Co-op at 30–45 Hz is fine. |
| Stardew Valley | 2D farming, life sim | ~85% | Tilemaps (D3), pixel-perfect mode (D7), and many gameplay systems; co-op netcode. |
| Club Penguin | 2D social MMO | ~80% | Tilemaps (D3), room and instance orchestration, chat, and moderation. MMO infrastructure is outside the engine. |
| GrandChase | Side-scrolling action MMO | ~75–80% | 2D skeletal animation (D5) and action-combat prediction feel. |
| SpeedRunners | 2D physics racer | ~75–80% | 2D physics fidelity at a low tick is the risk; D1–D4 close the rest. |
| Transformice | 2D physics multiplayer | ~70–75% | 2D rigid-body physics and syncing shared physics objects across many players; rooms and chat. |
| Unturned | Low-poly survival sandbox | ~55–65% | Large-world streaming (A1, T2), vehicle physics, base building, persistence, and modding. |
| Team Fortress 2 | Class-based arena FPS | ~30–40% | Source movement and 66 Hz fidelity against the 45 Hz cap; lag-compensation precision (H17, H18). |
| Rust | Hardcore survival | ~30% | 100–300 players per server, persistence, a huge procedural world, physics, and anti-cheat. |
| ARK: Survival Evolved | Survival with creature AI | ~25–35% | Huge world streaming, dense creature AI, physics, persistence, modding, and memory. |
| VRChat | Social VR platform | ~15–25% | No WebXR session, stereo rendering, render-rate pose, full-body IK, UGC avatar pipeline, or voice; plus moderation and security. |
| CS:GO / CS2 | Competitive tactical FPS | ~20–25% / ~10–15% | Built on 64–128 tick and sub-tick networking; the 45 Hz ceiling removes the fidelity. Anti-cheat and CS2 volumetrics are out of scope. |
| Fortnite | Battle royale | ~10–15% | 100-player scale, a huge streaming world, destructible building, high-end rendering, consoles, and anti-cheat. |

Notes:

- The tick ceiling decides only CS:GO/CS2 (64–128) and TF2 (66), and is
  marginal for SpeedRunners. Fortnite's server tick (~30) fits; its blockers
  are scale, destruction, and fidelity.
- Survival and sandbox titles are gated by scale, streaming, persistence, and
  UGC, not by the core loop, ECS, or renderer.
- Social titles are gated by platform features (VR, IK, UGC, voice) and
  operations (rooms, chat, moderation), not rendering.
- Every high-feasibility entry assumes the netcode hardening (H14–H20) and
  physics are done. Without them, drop each by a tier.

## Done (do not reopen without new evidence)

- Render layers, camera masks, multi-camera views, per-view rect, priority, and
  clear.
- Manager normalization: capacity throw and log, branded handles, events,
  counts.
- `camera: false`, lazy primary camera resolution, and camera docs.
- Netcode: custom snapshot types, prediction outcomes, AABB interest,
  composable interest, and lost-intent retransmit.
- `net/wire` extraction, session registry, and the dirty-state checker.
- Protocol fingerprinting exists; it hashes field size, not type (H12).
- LOD chains: prefab inheritance, per-instance override, a dither crossfade
  between levels, skinned and nested multi-part LOD, matching-part and skeleton
  checks, and model-sheet budget enforcement (throws at
  `SparseBatcher.MAX_SHEETS`). Geomorph is not implemented (H24).
- Prediction RNG: `ctx.rng` is re-seeded before every prediction and replay
  from the intent's client tick, entity, sequence, and the `rngSeed` option,
  with a regression test in `NC/packets/rng.test.ts`. Prediction and replay on
  the client agree; client and server agree only when the entity ids match
  (H18).
- Ribbons (V1–V4): `renderer.ribbons` with lines, ribbons, trails, and beams in
  one shared strip batch, separate pools and capacities, layer filtering,
  textured alpha and additive blends, tick-updated heads and endpoints, and
  render-alpha interpolation. See `docs/renderer.md`.
- `AGENTS.md` and the `murow/gpu` READMEs corrected; `packages/webgpu/CLAUDE.md`
  removed.

Rejected after checking the source:

- `InputManager.peek()` overwriting the tick snapshot. `peek()` writes the other
  buffer; it can only overwrite the snapshot from two calls ago.
- Engine 3D pipelines not back-face culling. `cullMode: 'none'` is the
  documented default, engine fragments flip back-face normals, per-material
  `cull` works, and `pbr` defaults to `'back'`.

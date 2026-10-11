# Murow 3D Material System — Design & Implementation Plan

Status: **proposal / not implemented**. There is currently **no material system and no
PBR** in murow. This document is self-contained: it assumes zero prior context.

---

## 0. TL;DR

We want to attach **custom shading to 3D prefabs** (cube, plane, sphere, cylinder,
cone, mesh, glTF) and to instances of them — the thing every engine calls a
*material*. Today the 3D renderer only has fixed built-in shaders; you can set a
texture and a color per instance, nothing more.

This plan introduces:

- a **`MaterialSpec`** (declarative, renderer-side) with four shading types:
  `standard`, `unlit`, `emissive`, `shader`;
- **render state** (blend / depth / cull) as separate fields;
- **`renderer.createMaterial(spec)`** returning a typed **`MaterialHandle`** that
  carries an **integer slot**; there is no string registry and no bucket lookup;
- a **single `MaterialParams` SoA storage buffer** indexed by `materialId`, so params
  update in one write and are read O(1) in the shader;
- **shared/global values in the scene uniforms** (group 0), not per material;
- **per-material textures** resolved to a dense `gpuIndex` at compile time;
- **batching by `(modelId, materialId)`** using `SparseBatcher` with
  `layer = materialId`, `sheet = modelId`;
- **per-instance parameters** reusing `custom0/custom1`.

Explicit non-goals for the first pass: true PBR (metalness/roughness), shadow maps,
and post-processing/bloom. Those are separate features and are documented in §11.

---

## 1. Audience & scope of this doc

This is written for an engineer (or AI) with **no knowledge of murow**. It explains:

1. what murow is and the conventions that constrain a material system (§2–§4);
2. how the 3D renderer is structured today (§5);
3. what a material is, precisely (§6);
4. the proposed spec/API/architecture (§7–§9);
5. **every decision point as options with trade-offs and a recommendation** (§10);
6. the ordered implementation steps and tests (§12–§14);
7. open questions (§15).

Read §15 first if you are the decider; read §12 first if you are the implementer.

---

## 2. Murow in one screen (context)

Murow is a small TypeScript game engine, data-oriented, zero runtime dependencies in
its core. Key rules (from `AGENTS.md` and `llms.txt`, the canonical AI reference at the
repo root and at <https://murow.moureau.dev/llms.txt>):

- **No entity/component classes.** Components are typed binary schemas
  (`defineComponent`); an entity is a plain `number`.
- **No scene graph, no `Object3D`, no live per-frame material editing.**
- **No per-frame allocation in hot loops.** Use `Float32Array`, `FreeList`, `SlotMap`,
  `SlotSet`, `SparseBatcher`.
- **Simulation in `tick`, drawing in `render`.** `GameLoop` owns ticks.
- **Deterministic predictions:** no `Math.random()`, `Date.now()`, `performance.now()`,
  no I/O, no module-level mutable state in prediction code.
- **The server is authoritative** for multiplayer.
- **`murow` core is pure CPU / renderer-agnostic.** GPU work lives in
  `@murow/webgpu` (bundled into the published `murow` package as `murow/webgpu`).

Monorepo layout:

```
packages/
  murow/      # published package `murow` (core + renderer contracts + copies of webgpu/netcode dist)
  webgpu/     # @murow/webgpu — the WebGPU renderer backend (where this plan lives)
  netcode/    # @murow/netcode — multiplayer layer
  website/    # docs site (Newstack SSG) at https://murow.moureau.dev
examples/*    # runnable example games
benchmarks/   # comparative benchmarks
```

Build/test (use `bun`, not `node`/`npm`; scripts call `npm run` internally):

```sh
# inside a package
bun test ./src
bunx tsc --noEmit -p tsconfig.json
bun run build        # tsc --emitDeclarationOnly + esbuild (dist/esm, dist/cjs)
bun run build:js     # esbuild only

# repo root
bun run build        # builds every package and copies webgpu/netcode into murow/dist
bun run test         # build + run all package tests
```

Dual ESM+CJS output via esbuild; types via `tsc`. The published `murow` package ships
`dist/webgpu/**`, `dist/netcode/**`, and a self-contained CDN bundle
`dist/webgpu/esm/murow.webgpu.bundle.js` (all deps inlined).

---

## 3. CDN / no-build reality (important for shader design)

The WebGPU renderer supports a **zero-build browser path**. The single-file bundle
`murow.webgpu.bundle.js` is used directly from jsDelivr:

```html
<script type="importmap">
{
  "imports": {
    "murow": "https://cdn.jsdelivr.net/npm/murow@0.1.13/+esm",
    "murow/webgpu": "https://cdn.jsdelivr.net/npm/murow@0.1.13/dist/webgpu/esm/murow.webgpu.bundle.js"
  }
}
</script>
```

Consequences that shape the material system:

- **Shaders are transpiled at runtime.** Shader functions are plain JS functions;
  `attachShaderMetadata` parses `fn.toString()` with `acorn` + `tinyest-for-wgsl` and
  attaches TypeGPU metadata via a global `WeakMap`. This must survive **minification**.
  See `packages/webgpu/src/shaders/runtime-transpile.ts` and its test file
  (`runtime-transpile.test.ts`), which builds the real bundle and validates every
  shader. The CDN bundle disables `minifySyntax` for exactly this reason.
- Therefore a custom material should be authored in the **declarative** form (plain
  functions), not as pre-built `tgpu.vertexFn(...)`. The declarative path is what the
  runtime transpiler can recover after minification. Pre-built TypeGPU functions only
  work with a build plugin (`unplugin-typegpu`).
- `'use gpu'` directives are **optional** for the runtime path (stripped if present).
  Do not require them.

`unplugin-typegpu` is available for bundler users (Vite etc.) and is what the
`multiplayer-cube-arena` example uses, but the material system must not depend on it.

---

## 4. The asset pipeline (buckets) and where materials fit

Assets are declared, loaded, then referenced by id. The pure-CPU contract lives in
`packages/murow/src/renderer/buckets/`:

- `Bucket` (generic base), `TextureBucket`, `PrefabBucket`, and `AssetBucket`.
- `PrefabBucket` extends the core `Bucket`; `AssetBucket(('3d'|'2d'))` combines a
  `TextureBucket` and a `PrefabBucket`.

```ts
const assets = new AssetBucket('3d')
  .textures(({ bucket }) => bucket
    .add({ type: 'texture', id: 'flame', src: '/flame.png' }))
  .prefabs(({ bucket }) => bucket
    .add({ type: 'cube',  id: 'box',  size: 1 })
    .add({ type: 'plane', id: 'wall', width: 4, height: 3, texture: 'flame' }));

await assets.load();
const box = assets.prefabs.get('box');
```

- `AssetBucket.textures` and `.prefabs` are **callable accessors**: use as a property
  or call with a callback that **must return the bucket**.
- The renderer uploads these in `init()`.

**Materials are not a CPU bucket.** A material carries TGSL functions and GPU types, so
it cannot live in pure-CPU core, and it must be created after the GPU device exists.
Materials are therefore **renderer-created values** (`renderer.createMaterial(spec)`),
not declared in `AssetBucket` and not referenced by string id. Texture ids used by a
material are resolved to dense integer `gpuIndex` values at compile time (§9.6).

---

## 5. The 3D renderer today (post-reorg structure)

`WebGPU3DRenderer` (`packages/webgpu/src/3d/renderer/renderer.ts`) is an orchestrator.
Its collaborators live in sibling folders:

```
packages/webgpu/src/3d/
  renderer/
    renderer.ts                 WebGPU3DRenderer (public API + render())
    index.ts                    public barrel
    types/                      public types + type helpers
    handles/                    `export declare namespace Handles { … }` (all handle types)
    cull/frustum/               Frustum
    cull/skin-cull/             SkinCull (frustum + distance compute-budget)
    lights/                     LightSystem (+ LightHandle, declared in handles/)
    instances/instance-store.ts         non-skinned pool
    instances/skinned-instance-store.ts skinned pool (+ bone-offset pool + anim states)
    instances/offsets.ts                DYN_/STAT_/SSTAT_ field offsets
    instances/transform.ts              resolveTransform(opts)
    models/model-library.ts             GPU mesh registry (primitives + glTF upload)
    textures/texture-registry.ts        uploaded textures + bind groups + white fallback
    pipelines/mesh-pipelines.ts         ALL raw GPU resources + the 4 render pipelines
    animation/skeletal-runtime.ts       GPU skinning loop (kernel, packing, bone buffer)
    animation/clip-resync-coordinator.ts lazy clip reload
    raycast/                    WebGPURaycast3D + RaycastController
    resize/                     ResizeController
  shader/shader.ts              TGSL shader factories (mesh, skinned, textured) + MAX_LIGHTS
  hitbox/hitbox.ts              HitboxDebugRenderer
  morph-animation/              MorphAnimation
```

Key collaborators relevant to materials:

### `MeshPipelines` (`pipelines/mesh-pipelines.ts`)

Owns **every** raw GPU resource: TypeGPU layouts (`meshLayout`, `skinnedMeshLayout`),
buffers (`dynamicBuffer`, `staticBuffer`, `uniformBuffer`, `slotIndexBuffer`,
`lightBuffer`, `rawBoneMatrixBuffer`, skinned equivalents), bind groups (`rawBindGroup`
group 0, `rawSkinnedBindGroup`), the four render pipelines (`rawPipeline`,
`rawTexturedPipeline`, `rawSkinnedPipeline`, `rawSkinnedTexturedPipeline`), and the depth
texture. `build()`, `setBoneBuffer()`, `resizeDepth()`, `destroy()`.

Pipelines are **hardcoded** (`createRenderPipeline` with fixed `depthStencil` and alpha
blend). There is no pipeline factory keyed by render state. Group 0 carries
`uniforms`, `dynamicInstances`, `staticInstances`, `slotIndices`, `lights`.

### `ModelLibrary` (`models/model-library.ts`)

Dense `models: ModelEntry[]` (array index = model id, O(1) `get`). An entry holds the
raw vertex/index buffers, counts, cull/pick bounds, `hasTexture`, `textureBindGroup`,
`skinned`, `skinIndex`. `skinnedModels[]` holds the skeletal animation and
joint/bone data.

### `InstanceStore` / `SkinnedInstanceStore`

Dense, zero-GC instance pools built on core primitives:

- Both use **`SlotMap`** for slot allocation (dense `slots.activeSlots` for O(live)
  iteration) and core **`SparseBatcher`** for draw grouping.
- Per-instance texture overrides are **dense per-slot arrays** (`(GPUBindGroup|null)[]`),
  not `Map`s.
- Per-instance fields are offset-based (`instances/offsets.ts`). The GPU-side struct is
  `DynamicMesh` (12 f32) + `StaticInstance3D` / `SkinnedStaticMesh`.
- `SkinnedInstanceStore` also owns the bone-offset pool (intrusive `Int32Array` free
  list) and per-slot anim states.

### `StaticInstance3D` (`packages/webgpu/src/core/types.ts`)

```ts
export const StaticInstance3D = d.struct({
  scaleX: d.f32, scaleY: d.f32, scaleZ: d.f32,
  materialId: d.f32,          // ← EXISTS, currently UNUSED
  opacity: d.f32,
  tintR: d.f32, tintG: d.f32, tintB: d.f32, tintA: d.f32,
  custom0: d.f32, custom1: d.f32,   // ← per-instance params, available
});
```

`materialId` and `custom0/custom1` are already in the CPU↔GPU layout: the per-instance
hook for materials.

### `TextureRegistry` (`textures/texture-registry.ts`)

Dense `GpuTexture[]`. Each `TexturePrefab` is stamped with its integer `gpuIndex` at
upload; id lookup resolves through the asset bucket once at compile time. The 1×1 white
fallback is kept separately (`white`). Group 1 is `modelTexture` + `modelSampler`.

### `LightSystem` (`lights/`)

CPU-side SoA for dynamic lights (slots via `SlotMap`), packed into a storage buffer each
frame (`pack()`, `storePrevious()`). `MAX_LIGHTS = 64`.

### `SparseBatcher` (core)

Buckets keyed by `layer * 64 + sheet` (`MAX_LAYERS = 256`, `MAX_SHEETS = 64`).
`add`/`remove` are **O(1)** (per-slot bucket/index tracking); `remove` no longer scans
the bucket. `each(cb)` iterates buckets in ascending key order, zero-allocation.

---

## 6. What a "material" is

A material is **three things**, not just a texture:

1. **Shader pair** — vertex + fragment (the program).
2. **Parameters** — uniforms (numbers/vectors) and textures/samplers. A texture is one
   parameter; opacity, tint, time, scan speed are others.
3. **Render state** — blend mode, depth write/compare, cull, topology.

Example: Three.js `MeshStandardMaterial` = engine shader + `map`/`normalMap` (textures)
+ `roughness`/`metalness` (uniforms) + `transparent`/`side`/`depthWrite` (render state).

"Shader on the GPU" is not a 3D/2D distinction — a shader is always vertex/fragment/
compute. What makes an effect "3D" is receiving a **view-projection matrix** and doing
the 3D math / depth. The built-in mesh shader already does this; a material lets a user
replace it per prefab/instance.

---

## 7. Lighting model (how materials interact with lights)

Lighting in murow lives **inside the built-in fragment shaders**, not in a post step.

- `MeshUniforms` (uniform buffer, group 0 binding 0):
  `viewProjection: mat4x4f`, `alpha: f32`, `lightDirX/Y/Z`, `lightDirR/G/B`,
  `lightDirIntensity`, `ambientR/G/B`, `lightCount: u32`.
- `lights` storage buffer: array of `Light` (kind, pos/dir prev+curr, color, intensity,
  range, innerCos, outerCos, castsShadow, shadowMapIndex).
- `createMeshFragment` computes directional + ambient, then loops `lightCount` dynamic
  lights via the shared helper `lightContribution(...)` and finishes with `tonemap(...)`.
  Both helpers live in `packages/webgpu/src/shaders/utils.ts` and are exported as
  externals to the built-in fragments.
- **No shadows**: `shadowFactor` is hardcoded `1.0` inside `lightContribution`.
- This is **Lambert-ish, not PBR** — no metalness/roughness/energy model.

For materials:

- **`standard`** uses the same uniforms + `lightContribution`/`tonemap`.
- **`unlit` / `emissive`** skip the light loop.
- **`shader`** gets the same bind group (so it can read `scene` uniforms + lights and
  call the helpers) but chooses whether to.
- **Shared/global values** (`time`, `alpha`, wind, global tint) belong in the **scene
  uniforms** (group 0), written once per frame, so all materials read them for free.
  A value in a material's params exists only because it genuinely differs per material.
- **Normals**: lit shading needs a normal varying. A material that supplies its own
  vertex shader must transform/output normals; reusing the mesh vertex path gives them
  free. Expose a `lit` flag/variant so the engine can pick the vertex shader.
- **Tangent space for normal maps**: the mesh has `position`, `normal`, `uv` (no
  tangents). Derive a TBN from screen-space derivatives in the fragment shader.

---

## 8. Current limitations that this feature crosses

1. **No custom shader/material on 3D prefabs.** Vertex/fragment programs are fixed
   (`createMeshVertex`/`createMeshFragment` etc. in `3d/shader/shader.ts`).
2. **`createGeometry` + `.shaders(...)` exists only on the 2D renderer.** Not wired to
   the 3D prefab system, camera, or depth buffer.
3. **Pipeline state is fixed**: alpha blend only, `depthWriteEnabled: true`,
   `depthCompare: 'less'`, `cullMode: 'none'`. No additive blend, no per-material depth,
   no cull control.
4. **No post-processing / render targets** (separate feature — §11).
5. **Batching is by model id only** (`batcher.add(0, modelId, slot)`), and the
   textured/untextured pipeline choice is per batch.

---

## 9. Proposed architecture

### 9.1 Concepts

- **MaterialSpec** — declarative description (renderer-side, in `@murow/webgpu`).
- **Material** — the compiled CPU result (shader pair + params schema + render state).
- **MaterialHandle** — the typed live handle, carrying an **integer slot**. This is the
  only material identity; there is no string registry and no `.get(id)`.
- **MaterialLibrary** — owns the **dense** compiled resources: a `SlotMap` for slot
  allocation and slot-indexed parallel arrays (`pipeline[]`, `textureBindGroup[]`,
  uniform-schema offsets). Mirrors `ModelLibrary` / `LightSystem`.
- **MaterialParams** — one SoA storage buffer, indexed by `materialId`, holding every
  material's uniform values (§9.6).

### 9.2 Spec (draft)

```ts
// packages/webgpu/src/3d/renderer/materials/specs.ts
import type { AnyWgslData } from 'typegpu';

interface MaterialSpecBase {
  readonly id?: string;            // optional label for debugging only

  // --- render state ---
  readonly blend?: 'opaque' | 'alpha' | 'additive';
  readonly depthWrite?: boolean;
  readonly depthTest?: boolean;
  readonly cull?: 'back' | 'front' | 'none';
}

/** Engine-provided shaders, parameterized (a "material type"). */
interface StandardMaterialSpec extends MaterialSpecBase {
  readonly type: 'standard' | 'unlit' | 'emissive';
  readonly color?: readonly [number, number, number];
  readonly opacity?: number;
  readonly emissive?: number;      // emissive only
  readonly texture?: string;       // texture id, resolved to gpuIndex at compile
}

/** User shader — runtime-transpiled, same descriptor shape as GeometryBuilder. */
interface ShaderMaterialSpec extends MaterialSpecBase {
  readonly type: 'shader';
  readonly uniforms: Record<string, AnyWgslData>;      // schema
  readonly defaultUniforms?: Record<string, number | readonly number[]>;
  readonly textures?: Readonly<Record<string, string>>; // binding name → texture id
  readonly lit?: boolean;                              // pick lit vs unlit vertex path
  readonly shaders: DeclarativeShaders;                // { vertex: { out, fn }, fragment: { fn } }
}

export type MaterialSpec = StandardMaterialSpec | ShaderMaterialSpec;
```

`DeclarativeShaders` is the existing shape `GeometryBuilder.shaders(...)` accepts:

```ts
.shaders({
  vertex: { out: { uv: d.vec2f }, fn(ctx, input) { … } },
  fragment: { fn: (input) { … } },
})
```

### 9.3 Shader context (what a `shader` material can access)

Because shared state lives in one place, the split is:

```ts
{
  scene:   { viewProjection, alpha, time, lightDir…, ambient…, lightCount }, // group 0
  lights:  Light[],                    // group 0 storage buffer
  dynamic: DynamicMesh[],              // per-instance transform (interpolated)
  statics: StaticInstance3D[],         // scale/tint/opacity/materialId/custom0/1
  material:{ …user uniforms… },        // indexed from the MaterialParams buffer
  textures:{ map, mask, … },           // group 1
}
```

`scene` and `material` are split so engine and user uniforms never collide. `material`
is a view over this material's slice of the shared `MaterialParams` buffer. Prefer
putting anything world-wide in `scene`.

### 9.4 Registration & usage

```ts
const holo = renderer.createMaterial({
  type: 'shader',
  blend: 'additive',
  depthWrite: false,
  textures: { map: 'flame' },          // 'flame' resolved to gpuIndex at compile
  uniforms: { scan: d.f32, tint: d.vec3f },
  defaultUniforms: { scan: 2.0, tint: [0.35, 0.85, 1.0] },
  lit: false,
  shaders: {
    vertex:   { out: { uv: d.vec2f }, fn: ({ scene }, input) { /* … */ } },
    fragment: { fn: (input) { /* textures.map, material.scan */ } },
  },
});

const glow = renderer.createMaterial({ type: 'emissive', color: [1, 0.45, 0.1], emissive: 2.0 });

renderer.addInstance({ prefab: 'orb', material: holo });   // default
renderer.addInstance({ prefab: 'orb', material: glow });   // override
handle.setMaterial(glow);                                   // runtime swap (O(1))
handle.setMaterialParams(a, b);                             // custom0/custom1
holo.uniforms.scan += dt;                                   // typed, writes params SoA
```

`material` in `addInstance` / `setMaterial` accepts a `MaterialHandle` only. No strings.

### 9.5 Compilation (in `renderer.createMaterial`)

1. allocate a slot from the `MaterialLibrary` `SlotMap`;
2. resolve texture ids to `gpuIndex` (O(1)) and build the group-1 bind group;
3. wrap declarative shader fns like `GeometryBuilder.build()`'s declarative branch:
   `tgpu.vertexFn({ in, out })(fn)` / `tgpu.fragmentFn({ in, out })(fn)`;
4. call `attachShaderMetadata(...)` with the known external names (the `_WS` list);
5. create a `GPURenderPipeline` with the material's blend/depth/cull;
6. write `pipeline[slot]`, `textureBindGroup[slot]`, and the param offset/schema into the
   slot-indexed arrays.

Vertex inputs a material vertex shader receives: `position: @location(0) vec3f`,
`normal: @location(1) vec3f`, `uv: @location(2) vec2f`, `instanceIndex: @builtin(instanceIndex)`.

### 9.6 Material parameters — one SoA buffer

Material uniforms live in **one** storage buffer, not one buffer per material:

```
group 0
  uniforms, dynamicInstances, staticInstances, slotIndices, lights,
  materialParams: array<f32, MAX_MATERIALS * PARAM_STRIDE>
```

- `materialId` = the material's slot. The shader reads
  `materialParams[u32(statics[slot].materialId) * PARAM_STRIDE + fieldOffset]`.
- Each material's uniform schema maps fields to offsets within its `PARAM_STRIDE` block
  (known at compile, like the instance offsets). Unused floats are padding.
- `holo.uniforms.scan = v` writes the CPU mirror; `render()` uploads the dirty range in
  **one** `writeBuffer`, exactly like `LightSystem`.
- `PARAM_STRIDE` and `MAX_MATERIALS` are renderer options with sensible defaults.
- Because every material compiles its own shader, heterogeneous uniform sets are fine —
  the shared buffer is flat `f32`, and each shader knows its own offsets.

This replaces the earlier "one uniform buffer + bind group per material" idea.

### 9.7 Rendering

- Group 0 is the shared mesh bind group plus the `materialParams` buffer.
- Group 1 is the material's textures (or the white fallback for param-only materials).
- **Batching key:** `batcher.add(materialId, modelId, slot)` — `layer = materialId`
  (≤255), `sheet = modelId` (≤63). `SparseBatcher.each` passes the flat key as an extra
  argument so the render loop recovers `materialId` and `modelId` O(1).
- `materialId` is written at spawn from the prefab default and overridden by
  `addInstance({ material })`.
- **`setMaterial(id)` must move the bucket**, not just write the field:
  `batcher.remove(oldId, modelId, slot); batcher.add(newId, modelId, slot)`. This is
  O(1) now that `SparseBatcher.remove` is O(1).
- **Two passes.** Opaque (`blend:'opaque'`) first with depth write/test; then
  transparent (`alpha`/`additive`, `depthWrite:false`). Draw within each pass in
  batcher key order. v1 does **not** depth-sort transparent instances (documented
  limitation); the batcher order is stable and allocation-free.
- Per-instance texture overrides remain their own path. **Material textures are
  per-material**, so a material batch shares one group-1 bind group and draws in one
  call; do not route material textures through the per-instance override array.

### 9.8 Where the code goes

```
packages/webgpu/src/3d/renderer/materials/
  specs.ts                 MaterialSpec union + render-state types
  material-library.ts      SlotMap + slot-indexed pipelines/bind groups/offset tables
  material-params.ts       the MaterialParams SoA buffer + CPU mirror + dirty upload
  built-in/                standard/unlit/emissive fragments (engine shaders)
  index.ts
  material-library.test.ts
```

Plus edits: `models/model-library.ts` (prefab → default material slot),
`instances/*` (materialId + batcher layer + `setMaterial` bucket move),
`pipelines/mesh-pipelines.ts` (pipeline factory with render state; add `materialParams`
to group 0), `renderer.ts` (public API + init wiring), and a small core change to
`SparseBatcher.each` (expose the flat key).

---

## 10. Decisions (options, trade-offs, recommendation)

Recommended choice first.

### A. Material type taxonomy

- **A1 (recommended): discrete types** `standard | unlit | emissive | shader`,
  discriminated by `type`, each with its own parser.
- A2: one `type: 'material'` with flags.
- A3: only `type: 'shader'`.

Recommendation: **A1**.

### B. Where material pipelines live

- **B1 (recommended): `MeshPipelines` owns all GPU resources**, including material
  pipelines and the `materialParams` buffer, exposing `buildMaterialPipeline(desc)`.
- B2: separate `materials/material-pipelines.ts`.
- B3: `MaterialLibrary` builds everything.

Recommendation: **B1** (matches how the bone buffer / skinned bind group are handled).

### C. Shader context naming

- **C1 (recommended): split `scene` (engine) and `material` (user).**
- C2: single `uniforms`.
- C3: prefixed names.

Recommendation: **C1**.

### D. Where materials are created

- **D1 (recommended): `renderer.createMaterial(spec)` returns a `MaterialHandle`.**
  Materials are GPU resources, created after `init()`, referenced by the handle. No
  string registry, no `AssetBucket` coupling.
- D2: a renderer-side `MaterialBucket` passed to the renderer. Two objects, still a
  registry.
- D3: a `materials` layer inside `AssetBucket`. Core stays pure only via injection;
  re-introduces string-prefab coupling and the two-registry confusion.

Recommendation: **D1**.

### E. Render-state surface

- **E1 (recommended): `blend`, `depthWrite`, `depthTest`, `cull` optional fields** with
  per-type defaults (`emissive` → `additive` + `depthWrite:false`).
- E2: a single `renderState: { … }` object.
- E3: no render state in v1.

Recommendation: **E1**.

### F. Batching strategy

- **F1 (recommended): batch by `(modelId, materialId)`** with
  `SparseBatcher(layer = materialId, sheet = modelId)`, extending `each` to expose the
  flat key. O(1) keying and O(1) `remove`; `setMaterial` moves the bucket.
- F2: per-model only.
- F3: per-frame sort (violates zero-GC).

Recommendation: **F1**. N materials = N draw calls; prefer prefab-level defaults.

### G. Scope of PBR

- **G1 (recommended for v1): no PBR.** `standard` = existing Lambert-ish + `tonemap`.
- G2: metalness/roughness in `standard`.
- G3: future `type: 'pbr'`.

Recommendation: **G1**, with G3 later.

### H. Core purity / where MaterialSpec types live

- **H1 (recommended): MaterialSpec + MaterialLibrary in `@murow/webgpu`.** Core stays
  pure-CPU.
- H2: generic bucket in core with a webgpu parser.
- H3: everything in core.

Recommendation: **H1**.

### I. Textures per material

- **I1 (recommended): `texture` (single) for engine types, `textures` map for
  `shader`.** Textures are per-material bind groups, resolved at compile.
- I2: `textures` map everywhere.
- I3: single everywhere.

Recommendation: **I1**.

### J. Per-instance parameters

- **J1 (recommended): reuse `StaticInstance3D.custom0/custom1`**, exposed as
  `handle.setMaterialParams(a, b)`. Named per-material uniforms live in the shared
  `MaterialParams` SoA (`holo.uniforms.scan`), not per instance.
- J2: per-instance uniform buffers (heavy).
- J3: none in v1.

Recommendation: **J1**.

### K. `MaterialHandle` shape

- **K1 (recommended):**
  ```ts
  interface MaterialHandle<U extends Record<string, AnyWgslData>> {
    readonly slot: number;                       // = materialId
    readonly uniforms: UniformValues<U>;         // typed accessors over MaterialParams
    setTexture(name: string, texture: string | TexturePrefab): void;
    destroy(): void;
  }
  ```
  `UniformValues<U>[K] = Infer<U[K]>` (TypeGPU `Infer`), so `holo.uniforms.scan` is a
  `number` and `holo.uniforms.tint` a `v3f`. `slot` is the only identity; there is no
  string id.
- K2: expose the raw pipeline/bind group. Leaky.
- K3: reference by id everywhere. Less ergonomic and re-introduces string lookup.

Recommendation: **K1**.

---

## 11. Explicit non-goals (separate features)

- **PBR** (metalness/roughness/IBL) — decision G.
- **Shadow maps** — `lightContribution` hardcodes `shadowFactor = 1.0`.
- **Post-processing / camera filters** — needs render-to-texture + a fullscreen pass
  chain + sampleable depth. Enables bloom, vignette, DOF, SSAO, CRT, color grading.
- **Custom geometry on the 3D renderer** (`createGeometry`) — shares the plumbing.
- **Billboard/VFX pipeline** (3D particles) — the render state from decision E is a
  prerequisite; the rest is a separate renderer path.
- **Depth-sorted transparency** — v1 draws transparent batches in material order.

---

## 12. Implementation steps (ordered, each lands green)

Verification after every step: `bunx tsc --noEmit -p tsconfig.json`, `bun test ./src`,
`bun run build:js` inside `packages/webgpu`.

1. **Core: extend `SparseBatcher.each`** to pass the flat key (4th arg). Add a test.
2. **`materials/specs.ts`** — `MaterialSpecBase`, `StandardMaterialSpec`,
   `ShaderMaterialSpec`, `MaterialSpec`, render-state types.
3. **`MeshPipelines` render-state factory** — a pipeline builder taking
   `{ shaderModule/layout, blend, depthWrite, depthTest, cull }`; refactor the four
   existing pipelines to use it (no behavior change).
4. **`materials/material-params.ts`** — the `MaterialParams` SoA buffer + CPU mirror +
   dirty-range upload; unit-test offset math and defaults.
5. **`materials/material-library.ts` (engine types only)** — `SlotMap` + slot-indexed
   pipelines/bind groups; compile `standard`/`unlit`/`emissive`; `createMaterial`
   returns a `MaterialHandle<U>`. Unit-test slot reuse and descriptor mapping with a
   mock device.
6. **Wire into `render()`** — prefab default material slot at spawn; batch by
   `(modelId, materialId)`; two passes (opaque then transparent); bind the material
   pipeline + group 1.
7. **Per-instance override** — `addInstance({ material })` + `handle.setMaterial(slot)`
   (including the O(1) bucket move) + `handle.setMaterialParams(a, b)`.
8. **`type: 'shader'`** — declarative wrapping + `attachShaderMetadata` + known external
   names + shader context (`scene`/`material`/`textures`/`lights`/`dynamic`/`statics`).
   Add a minified-shader regression test using the `runtime-transpile.test.ts` harness.
9. **Docs + sample** — an emissive and a fresnel/hologram example; update `llms.txt`,
   `packages/webgpu/README.md`, the website, and the Basebox demo.

---

## 13. Testing strategy

- **Pure / CPU-testable:** spec validation, texture-id→`gpuIndex` resolution, uniform
  defaults + offsets, render-state defaults, `(modelId, materialId)` batch keying,
  `setMaterial` bucket move, `MaterialHandle` uniform writes, `SparseBatcher.each` key.
- **Transpile-dependent:** custom `shader` materials validated under minification via
  `packages/webgpu/src/shaders/runtime-transpile.test.ts`.
- **GPU-bound:** `createRenderPipeline` / bind groups — mock device for descriptor
  assertions where cheap; otherwise the browser demo.
- **End-to-end:** the `multiplayer-cube-arena` example and a Basebox-deployed demo
  (§14).

---

## 14. Manual verification

- Build the repo: `bun run build` (root).
- Run `examples/multiplayer-cube-arena` (`bun run dev`) in two tabs.
- Deploy a Basebox demo exercising: a lit `standard` sphere, an `emissive` additive
  glow, and a `shader` hologram with a texture, plus per-instance `setMaterial`
  toggling. Confirm no console errors and correct depth/blend behavior.

---

## 15. Open questions (decide before/while implementing)

1. **PBR now or later?** (decision G).
2. **`PARAM_STRIDE` / `MAX_MATERIALS` defaults** and whether they are renderer options.
3. **Blend modes:** `opaque | alpha | additive` enough, or also `premultiplied` /
   custom `{ srcFactor, dstFactor }`?
4. **Per-instance uniforms:** `custom0/custom1` only (recommended), or a per-instance
   buffer?
5. **Engine material defaults:** `emissive` = additive + `depthWrite:false`.
6. **Sampler/wrap control:** should `TextureSpec` carry `repeat`/`clamp`/sRGB?
7. **Transparent ordering:** accept material-order draws for v1, or add a depth sort?
8. **Lit custom materials:** `lit: true` toggle (recommended) vs manual helper calls.
9. **Versioning/compat:** the only existing-symbol change is adding `material?` to
   instance options; material types are additive.
10. **Docs location:** module docs in `materials/` (README) and a `llms.txt` section.

---

## 16. Glossary

- **AssetBucket** — the CPU asset declaration/load container (`textures` + `prefabs`).
- **Prefab** — parsed CPU asset (`CubePrefab`, `PlanePrefab`, `GltfPrefab`, …).
- **Model / ModelHandle** — the GPU mesh a prefab becomes after `init()`.
- **Instance / InstanceHandle / MeshInstanceHandle** — a spawned object, with a transform.
- **Material** — shader + parameters + render state.
- **MaterialSpec** — the declarative description.
- **MaterialHandle** — the live typed handle; `slot` is the material identity.
- **MaterialLibrary** — dense (`SlotMap`) registry of compiled material resources.
- **MaterialParams** — the single SoA storage buffer holding every material's uniforms.
- **MeshPipelines** — the class owning raw GPU buffers/pipelines/bind groups/depth.
- **SparseBatcher** — core O(1) add/remove bucket batcher; `layer = materialId`,
  `sheet = modelId`.
- **Runtime transpile** — parsing `fn.toString()` with acorn + tinyest to attach
  TypeGPU metadata without a build step (`attachShaderMetadata`).
- **Declarative shaders** — the `{ vertex: { out, fn }, fragment: { fn } }` shape the
  runtime transpiler understands.
- **Render state** — blend/depth/cull/topology baked into the pipeline.
- **Scene uniforms** — engine per-frame uniforms (`viewProjection`, `alpha`, time, lights).

---

## 17. Engine-level gaps (beyond materials)

Features the renderer does not have yet, ordered by impact (biggest win, quickest
first). This section is engine-wide, not material-specific; §11 covers only what
the material system deliberately deferred.

1. **LOD + distant billboard impostors.** No distance-based mesh swap, so far
   geometry costs full vertex/fragment work. Biggest scaling win for large
   scenes and crowds; moderate effort (needs per-model LOD levels + an imposter
   path).
2. **Depth-sorted transparency.** Transparent instances draw in material/batcher
   order, not back-to-front, so overlapping transparency mis-sorts. Correctness
   fix; quick (a per-frame depth sort or order-independent blend).
3. **Custom 3D geometry** (`createGeometry` + custom vertex/fragment on the 3D
   renderer). Exists only on the 2D renderer. Shares the existing mesh/instancing
   plumbing; unlocks procedural meshes and terrain. Quick.
4. **Batched world-space text/billboards + depth occlusion.** The projection
   primitive already exists (`renderer.worldToScreen`), and consumers exist
   (`HTMLDom`, `ParticleSystem3D`, or a second overlay canvas). Missing: a
   glyph-atlas billboard pipeline for thousands of labels, depth-tested occlusion
   (labels currently draw over walls), and a documented overlay-canvas recipe.
   `HTMLDom` covers the dozens case. Medium.
5. **Occlusion culling / GPU-driven (indirect) draws.** Only CPU frustum culling
   today; hidden geometry is still submitted. Big perf win for dense scenes;
   medium.
6. **PBR** (metalness/roughness, IBL). `standard` is Lambert-ish with no energy
   model; the biggest visual-quality gap. Medium.
7. **Anti-aliasing** (MSAA/TAA). No sample count in the main pass and no temporal
   AA, so edges alias. Quick for MSAA; heavier for TAA.
8. **Crowd steering / RVO / local avoidance.** Only `NavMesh` (pathfinding)
   exists; no agent steering or avoidance. Gameplay-level; medium-big.

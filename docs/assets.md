# Asset pipeline in murow

murow's asset pipeline is a typed registry, not a loader you call from render code. You **declare** every texture, model, and spritesheet up front, **load** them in parallel, then look them up by a string id that carries its parsed type through to the call site. Because the bucket knows the geometry upfront (joint counts, skinned-part counts, vertex totals), the renderer can size its GPU buffers from the bucket instead of from magic numbers. The parsers are pure CPU, so the same declarations run on a headless server or a test.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **Declare everything before `load()`.** `add()` after `load()` throws; a bucket is frozen once loaded.
2. **Callbacks passed to `.textures()` / `.prefabs()` must return the bucket.** An expression body (`({ bucket }) => bucket.add(...)`) or an explicit `return`; a block that only calls `add` registers nothing.
3. **Load through the bucket, not by hand.** `await assets.load()` resolves all textures and prefabs in parallel; the bucket owns fetching, parsing, and GPU buffer sizing.
4. **Look up by typed id.** `assets.prefabs.get('hero')` narrows to `GltfPrefab`, so `hero.animations.Idle` is a literal and a typo is a compile error.
5. **Eager-load only the clips you need at spawn.** Pass `animations: [...]`; fetch the rest later with `prefab.loadAnimations(...)` and release them with `unloadAnimations(...)`. Use `freezeAnimations: true` when you will never lazy-load.
6. **Pass the loaded bucket to the renderer.** `new WebGPU3DRenderer(canvas, { assets })` / `WebGPU2DRenderer(canvas, { assets })` upload the prefabs and size themselves from them.
7. **Remember the compression gaps.** There is no KTX2 / Basis / DDS support and no Draco / meshopt decoding today (see below). Ship uncompressed geometry and standard PNG/JPEG.

## The model

The pipeline has three layers:

1. **Specs** — pure data describing what to load (`{ type, id, src, ... }`). No I/O.
2. **Parsers** — one per `type`, registered by the bucket; they fetch and parse the spec into a CPU-side result.
3. **Prefabs** — the parsed result, retrieved by id with full type narrowing.

`AssetBucket` is the user-facing entry point. It wraps a `TextureBucket` (`assets.textures`) and a `PrefabBucket` (`assets.prefabs`) under one `load()` lifecycle. Both load in parallel via `Promise.all`.

```
new AssetBucket(mode)      // mode: '2d' | '3d' — narrows what prefabs() accepts
  .textures(cb)            // register TextureSpecs
  .prefabs(cb)             // register prefab specs (both callbacks MUST return the bucket)
await assets.load()        // parallel fetch + parse; bucket frozen
assets.textures.get(id)    // TexturePrefab
assets.prefabs.get(id)     // narrowed prefab (GltfPrefab, CubePrefab, …)
```

`get(id)` autocompletes known ids and narrows to the matching variant; `get('typo')` is a compile-time error. Unknown-but-typed ids resolve to the union at compile time and throw at runtime. `find(id)` returns `undefined` instead of throwing; `entries()` returns all parsed prefabs in registration order; `size` and `loaded` report state.

**Self-sizing.** The glTF parser records `totalVertexCount`, `skinnedPartCount`, and `jointCount` on each `GltfPrefab`. When you pass `assets` to `WebGPU3DRenderer`, it walks `assets.prefabs.entries()` to derive its skinned-instance and bone budgets (`maxSkinnedInstances`, `maxBonesPerSkin`), and defaults `maxInstances` to `bucket.size + 16`. The 2D renderer uploads every spritesheet prefab during `init()` and resolves `sprites.add({ sheet: ... })` to the right handle. Explicit options still win.

## Worked examples

### Declare → load → typed lookup

```ts
import { AssetBucket } from 'murow';

const assets = new AssetBucket('3d')
  .textures(({ bucket }) => bucket
    .add({ type: 'texture', id: 'brick', src: '/brick.png' })
  )
  .prefabs(({ bucket }) => bucket
    .add({ type: 'cube',  id: 'crate', size: 1, metadata: { hp: 10 } })
    .add({ type: 'plane', id: 'wall',  width: 4, height: 3, texture: 'brick' })
    //                                                       ^ autocompletes to 'brick'
  );

await assets.load();

const crate = assets.prefabs.get('crate');   // CubePrefab; crate.metadata.hp === 10
const wall  = assets.prefabs.get('wall');    // PlanePrefab
```

Because textures are declared first, every spec with a `texture` field (`plane`, `cube`, `sphere`, `cylinder`, `cone`, `mesh`) autocompletes to the registered texture ids.

### 3D primitive, grid, and composite specs

```ts
import { PrefabBucket } from 'murow';   // usually reached via assets.prefabs

const bucket = new PrefabBucket('3d')
  .add({ type: 'grid', id: 'floor', size: 50, step: 1, lineWidth: 0.01 })
  .add({ type: 'cube', id: 'campfire.logs',  size: 1 })
  .add({ type: 'cube', id: 'campfire.flame', size: 0.3 })
  .add({
    type: 'composite',
    id: 'campfire',
    parts: [
      { partId: 'campfire.logs' },
      { partId: 'campfire.flame', offset: { position: [0, 0.3, 0] } },
    ],
  });

await bucket.load();
bucket.get('campfire');   // CompositePrefab — spawning it spawns one child per part
```

A `composite` wires already-registered prefabs into one spawnable instance with per-part local offsets. `PartOffset` is `{ position?: [x,y,z]; rotation?: [x,y,z] }`.

### glTF: eager vs on-demand animations

```ts
const assets = new AssetBucket('3d')
  .prefabs(({ bucket }) => bucket.add({
    type: 'gltf',
    id: 'hero',
    src: '/hero.glb',             // .glb (single file) or .gltf (+ external buffers)
    animations: ['Idle'],         // eager-loaded
    metadata: { scale: 0.01 },
  }));

await assets.load();

const hero = assets.prefabs.get('hero');
hero.animations.Idle;             // typed literal 'Idle'
hero.animationList;               // readonly ['Idle']
hero.metadata.scale;              // typed as 0.01
hero.jointCount;                  // drives the renderer's bone budget
hero.totalVertexCount;
hero.skinnedPartCount;

await hero.loadAnimations?.(['Run', 'Attack']);   // fetch + decode on demand
hero.unloadAnimations?.(['Attack']);              // free GPU bone-matrix buffers
hero.resetAnimations?.();                         // back to the spec-declared set
```

Animation semantics on the spec:

- **omitted** — load all clips; `animationList` is the GLB's discovered names.
- **`[]`** — load zero clips (a static skinned model); no `animationList`.
- **`['Run', 'Idle']`** — load only those, with a literal-typed record.

`freezeAnimations: true` releases the retained glTF JSON and accessor reader after parse. It saves memory but **removes `loadAnimations` / `unloadAnimations` / `resetAnimations` at both the value and type level** — use it when the clip set is fixed. `loadAnimations` on an already-loaded name is a no-op; an unknown name throws.

### Spritesheets (2D)

```ts
const assets = new AssetBucket('2d').prefabs(({ bucket }) => bucket.add({
  type: 'spritesheet',
  id: 'characters',
  src: '/characters.png',
  frameWidth: 32,
  frameHeight: 32,
  // or: data: '/characters.json'   // texture-packer JSON, mutually exclusive
}));

await assets.load();
const sheet = assets.prefabs.get('characters');
sheet.frameCount; sheet.width; sheet.height;
```

Frame extraction has two modes: a fixed grid (`frameWidth` + `frameHeight`, left-to-right then top-to-bottom) or a texture-packer JSON (`data`, read from `frames` + `meta.size`). With neither, the whole image is one frame. `assets.prefabs.get('characters')` is passed straight to `sprites.add({ sheet: ... })`.

### Serving assets and the CDN

Specs take plain URLs and the parsers `fetch` them, so anything the browser can serve works: static files next to your bundle, an object store, or a CDN. Keep the URL scheme you already use for the engine. The zero-build browser setup loads murow itself from jsDelivr and pins a version for reproducibility:

```html
<script type="module">
  import { GameLoop, AssetBucket } from "https://cdn.jsdelivr.net/npm/murow@0.1.8/+esm";
  import { WebGPU3DRenderer } from "https://cdn.jsdelivr.net/npm/murow@0.1.8/dist/webgpu/esm/murow.webgpu.bundle.js";
</script>
```

Asset URLs are independent of that choice — point `src` at whatever origin serves your `.glb`, `.png`, and spritesheet JSON.

### Compression gaps (read this)

Compression is honest-to-goodness **not implemented** today:

- **No GPU-compressed texture formats.** There is no KTX2, no Basis Universal, and no DDS path. Textures decode to `HTMLImageElement` / `ImageBitmap` and upload as uncompressed RGBA. Ship standard PNG/JPEG; budget VRAM for the decoded size, not the file size.
- **No mesh compression.** The glTF parser does not decode **Draco** or **meshopt** (`EXT_meshopt_compression`) extensions. A `.glb` that requires either will not load. Export uncompressed geometry.
- **No general HTTP compression handling in the pipeline.** Whatever your host does at the transport level is what you get; the bucket does not pre/post-process payloads.

Treat these as gaps, not flags to toggle. If you need them, they have to be added or handled outside the pipeline.

### Reloading clips and `clips-changed`

Lazy animation changes are observable. `assets.prefabs.events` is an `EventSystem`; listen for `clips-changed` when `loadAnimations` / `unloadAnimations` mutate a prefab's clip set:

```ts
assets.prefabs.events.on('clips-changed', ({ prefabId, added, removed }) => {
  // re-sync anything caching that prefab's clip list
});

assets.prefabs.events.on('loading', ({ loaded, total, id }) => { /* progress */ });
assets.prefabs.events.on('load-complete', ({ total }) => { /* done */ });
```

Both inner buckets emit `loading` / `load-complete`; only the prefab bucket emits `clips-changed`. The WebGPU renderer subscribes internally (`GltfClipResyncCoordinator`) and re-uploads the affected skin's bone buffers, so runtime clip changes do not require restarting the renderer.

### Headless / pure-CPU parsers

The parsers do no GPU work and take no device. The bucket is just one consumer; you can call them directly on a server, in a test, or before a renderer exists:

```ts
import { parseGltf, parseSpritesheet, SkeletalAnimation } from 'murow';

const gltf = await parseGltf('/hero.glb', { animations: ['Idle'] });
// gltf.primitives, gltf.skin, gltf.source — plain CPU data

const sheet = await parseSpritesheet({ image: '/ui.png', frameWidth: 32, frameHeight: 32 });
// sheet.bitmap, sheet.uvs, sheet.width, sheet.height

const anim = new SkeletalAnimation(gltf.skin!.data, gltf.skin!.animClips);
const state = anim.createState('Idle');
anim.update(state, deltaTime, outputMatrices);   // zero-alloc bone-matrix write
```

`parseGltf(url, { animations?, freezeAnimations? })` returns `{ src, primitives, skin, source }`; `parseSpritesheet(source)` returns `{ bitmap, uvs, width, height }`; `SkeletalAnimation` is the CPU-side bone evaluator (`createState` / `update`, `play` with crossfade, `replaceClips`). These are the same functions the WebGPU backend uses, exposed for custom backends and headless tooling.

## Gotchas

- **A callback that does not return the bucket silently registers nothing.** `.prefabs(({ bucket }) => { bucket.add(...) })` returns `undefined`; use an expression body or `return`.
- **`add()` after `load()` throws** ("bucket is frozen"). Register every asset before you await `load()`.
- **Duplicate ids throw** at `add()` time, for both single adds and `addAll()`.
- **`get()` before `load()` throws**; `get('unknown')` throws. Use `find()` if you want `undefined`.
- **`freezeAnimations: true` deletes the lazy methods** from the type, not just runtime. Code that calls `loadAnimations` will not compile against a frozen prefab.
- **`loadAnimations` throws on an unknown clip name** (it does not silently skip); already-loaded names are no-ops.
- **No Draco / meshopt / KTX2 / Basis / DDS.** A compressed glTF extension or GPU texture format is not decoded. Export uncompressed.
- **`animations: []` is meaningful** — it is not the same as omitting the field. Omitted loads all clips; `[]` loads none.
- **Composite parts must already be registered** in the same bucket; `partId` is an id lookup, not an inline model.
- **`TexturePrefab.parsed` is an `HTMLImageElement`**; the backend converts it to a GPU texture at init. Do not assume it is GPU-resident after `load()`.

## Quick reference

| want | use |
|---|---|
| register textures | `new AssetBucket(mode).textures(cb)` → `TextureBucket.add(TextureSpec)` |
| register prefabs | `.prefabs(cb)` → `PrefabBucket.add(spec)` / `addAll([...])` |
| load everything | `await assets.load()` (idempotent; parallel) |
| typed lookup | `assets.prefabs.get('id')` / `assets.textures.get('id')` |
| optional lookup | `bucket.find('id')` (returns `undefined`) |
| all parsed | `bucket.entries()` (registration order); `bucket.size`, `bucket.loaded` |
| 3D model | `{ type: 'gltf', id, src, animations?, freezeAnimations?, metadata?, hitbox? }` |
| 2D sprite atlas | `{ type: 'spritesheet', id, src, frameWidth?, frameHeight?, data? }` |
| static primitives | `grid`, `cube`, `plane`, `sphere`, `cylinder`, `cone`, `mesh` |
| multi-part asset | `{ type: 'composite', id, parts: [{ partId, offset? }] }` |
| texture source | `{ type: 'texture', id, src }` |
| lazy clips | `prefab.loadAnimations([...])` / `unloadAnimations([...])` / `resetAnimations()` |
| clip change events | `assets.prefabs.events.on('clips-changed', ...)` |
| progress events | `bucket.events.on('loading', ...)` and `'load-complete'` |
| pass to renderer | `new WebGPU3DRenderer(canvas, { assets })` / `WebGPU2DRenderer(canvas, { assets })` |
| headless parse | `parseGltf(url, opts)`, `parseSpritesheet(source)`, `SkeletalAnimation` |
| self-sizing stats | `prefab.jointCount`, `prefab.skinnedPartCount`, `prefab.totalVertexCount` |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



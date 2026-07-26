# Renderer

Renderer-agnostic primitives for any rendering backend (WebGPU, PixiJS, Three.js, …). This module holds the **abstract contracts** that backends implement and the **asset pipeline** (parsing, spec registry, typed lookups) that they consume.

Everything here is **pure CPU**: no GPU, no canvas, no device. The webgpu (or any) backend is responsible for the upload step.

## Folder layout

```
renderer/
├── base/              — abstract renderer contracts
│   ├── renderer.ts        (BaseRenderer)
│   ├── renderer-2d.ts     (Base2DRenderer)
│   └── renderer-3d.ts     (Base3DRenderer)
├── gltf/              — glTF / .glb parsing + skeletal animation
│   ├── parser.ts          (parseGltf — fetch + parse a URL)
│   ├── skin-parser.ts     (parseSkin, parseAnimations, packing)
│   └── skeletal-animation.ts
├── spritesheet/       — pure UV math + image loading
│   ├── helpers.ts         (computeGridUVs, computeTexturePackerUVs, loadImage)
│   └── parser.ts          (parseSpritesheet)
├── buckets/           — typed registries for textures, prefabs, and assets
│   ├── bucket/            (generic Bucket base)
│   ├── texture/           (TextureBucket — texture specs → ImageBitmap)
│   ├── prefab/            (PrefabBucket — spec → prefab for 2D/3D)
│   │   ├── prefab.ts
│   │   └── utility/       (BasePrefabBucket, specs, parsers, concrete)
│   └── asset/             (AssetBucket — textures + prefabs under one roof)
├── raycast/           — abstract pick / ray-test contracts
│   └── raycast.ts         (Raycast, RaycastMemo, RaycastHit, RaycastOptions)
├── math.ts            — TRS/mat4 math (zero-alloc)
└── types.ts           — SpriteHandle, SpritesheetHandle, Camera*State, etc.
```

## Assets

The asset pipeline has three layers:

1. **Specs** — declarative descriptions of what to load (a URL, a size, segments). Pure data, no I/O.
2. **Parsers** — registered per spec `type`, each turns a spec into its parsed result (fetch + parse glTF, decode image, etc.).
3. **Results** — typed CPU data ready for a renderer (`TypedArray`s, `ParsedGltf`, `ImageBitmap`, etc.).
4. **Buckets** — typed registries that collect specs, run parsers in parallel, and hand back parsed results by id with full type narrowing.

Each layer is type-safe: known ids like `assets.prefabs.get('hero')` return the concrete prefab variant (`GltfPrefab` with `.animations`, `.jointCount`, etc.), not the union. Unknown ids like `'typo'` still compile (autocomplete nudges you toward the right ones) but resolve to the full prefab union at compile time and throw at runtime.

### AssetBucket

The primary user-facing entry point. Wraps a `TextureBucket` and a `PrefabBucket` under a single `load()` lifecycle, with **texture-id autocomplete** on prefab specs that accept one.

```typescript
import { AssetBucket } from 'murow';

const assets = new AssetBucket('3d')
  .textures(({ bucket }) => bucket
    .add({ type: 'texture', id: 'brick', src: '/brick.png' })
    .add({ type: 'texture', id: 'wood',  src: '/wood.png' })
  )
  .prefabs(({ bucket }) => bucket
    .add({ type: 'cube',  id: 'box',  size: 1 })
    .add({ type: 'plane', id: 'wall', width: 4, height: 3, texture: 'brick' })
    //                                                         ^ autocompletes to 'brick' | 'wood'
  );

await assets.load();

assets.textures.get('brick');   // TexturePrefab
assets.prefabs.get('wall');     // PlanePrefab (narrowed by id)
assets.loaded;                  // true
```

`textures` and `prefabs` are callable accessors — use them as properties, or call them with a callback to configure. Because textures are declared first, every prefab spec with a `texture` field (`PlaneSpec`, `CubeSpec`, `SphereSpec`, …) automatically autocompletes to the registered texture ids.

### Events

Both inner buckets expose an `.events` property (an `EventSystem`). You can listen to loading progress and runtime changes:

```typescript
// Progress during assets.load()
assets.prefabs.events.on('loading', ({ loaded, total, id }) => {
  console.log(`[${loaded}/${total}] ${id}`);
});
assets.prefabs.events.on('load-complete', ({ total }) => {
  console.log(`All ${total} prefabs loaded`);
});

// Runtime animation changes (skinned glTF prefabs with lazy clip loading)
assets.prefabs.events.on('clips-changed', ({ prefabId, added, removed }) => {
  console.log(`Prefab '${prefabId}': +${added.length} -${removed.length} clips`);
});
```

The same events are available on `assets.textures.events` (loading progress, load-complete). The `'clips-changed'` event is specific to the prefab bucket — it fires when `prefab.loadAnimations()` or `prefab.unloadAnimations()` mutates the clip set at runtime.

<details>
<summary>PrefabBucket — spec → prefab registry</summary>

The `PrefabBucket` powers `assets.prefabs`. You typically don't reach for it directly, but it's the engine behind typed lookups, hitboxes, groups, and metadata.

```typescript
import { PrefabBucket } from 'murow';

const bucket = new PrefabBucket('3d')
  .add({
    type: 'gltf',
    id: 'hero',
    src: '/hero.glb',
    animations: ['Idle', 'Run'],
    metadata: { scale: 0.01 },
  })
  .add({
    type: 'grid',
    id: 'floor',
    size: 20,
    step: 0.5,
    lineWidth: 0.002,
  });

await bucket.load();             // fetches everything in parallel

const hero = bucket.get('hero'); // typed as GltfPrefab — knows its animations
hero.animations.Idle;            // typed as 'Idle' (literal, not string)
hero.metadata.scale;             // typed as 0.01 (literal)

bucket.get('typo');              // ❌ compile error: not assignable to '"hero" | "floor"'
```

#### Lifecycle

1. **`add()` / `addAll()`** — collect specs (sync, no I/O). Chainable.
2. **`load()`** — resolves all async work (fetch, parse) in parallel. Frozen after this.
3. **`get(id)` / `getAllByType(type)`** — typed lookups.

The bucket carries derived stats (joint counts, skinned-part counts, vertex totals) so renderers can self-size their GPU buffers without you having to specify magic numbers.

#### Mode argument

- `new PrefabBucket('3d')` — accepts gltf / grid / cube / composite / sphere / cylinder / cone / mesh specs
- `new PrefabBucket('2d')` — accepts spritesheet specs

Use `addGroup(name, parts)` to register a set of prefabs under a dotted namespace (`bucket.get('campfire.logs')`) and `getGroup(name).asComposite()` to spawn the whole group as one logical instance with per-part offsets.

The mode narrows what `add()` accepts and what `get()` returns. Type-safe by construction.

#### Hitboxes

Attach a `HitboxLibrary` (see [`core/hitbox`](../core/hitbox) and [`core/raycast`](../core/raycast)) so specs can reference a pick shape by name:

```typescript
const lib = new HitboxLibrary('3d')
  .add('humanoid', new Hitbox('3d')
    .add('body', { shape: 'cylinder', radius: 50, height: 120, offset: [0, 40, 0] })
    .add('head', { shape: 'sphere', radius: 28, offset: [0, 130, 0] }));

const bucket = new PrefabBucket('3d')
  .hitboxes(lib)
  .add({ type: 'gltf', id: 'jinx', src: '/jinx.glb', hitbox: 'humanoid' });
```

`.hitboxes(lib)` narrows the `hitbox` field to the library's names — `'humanoid'` autocompletes and typos are compile errors, while any string is still accepted (`StringOr`) and resolves to the model bound if unregistered. Without a library, `hitbox` cannot be set.

#### Metadata

Every spec can carry user-defined `metadata: Record<string, unknown>`. Literal types preserved through to the prefab:

```typescript
.add({ type: 'gltf', id: 'hero', src: '/hero.glb', metadata: { scale: 0.01, hp: 100 } });
//                              bucket.get('hero').metadata is { scale: 0.01, hp: 100 }
```

</details>

<details>
<summary>TextureBucket — texture spec registry</summary>

The `TextureBucket` powers `assets.textures`. Collects texture specs and loads them as `HTMLImageElement`s in parallel.

```typescript
import { TextureBucket } from 'murow';

const bucket = new TextureBucket()
  .add({ type: 'texture', id: 'brick', src: '/brick.png' })
  .add({ type: 'texture', id: 'wood',  src: '/wood.png' });

await bucket.load();

const tex = bucket.get('brick');  // TexturePrefab — { id, src, parsed: ImageBitmap }
```

Each texture loads as an `HTMLImageElement` inside a `TexturePrefab`. The backend renderer (e.g. WebGPU) converts those to GPU textures during init. Texture ids feed into the `AssetBucket`'s autocomplete system — any prefab spec with a `texture` field narrows to the registered texture ids.

</details>

### Specs

Specs are the data you write in `add()`. They describe *what* to load, not the loaded result. Every spec has at minimum `type` and `id`, plus type-specific fields:

```typescript
// 3D
{ type: 'gltf',    id: 'hero',  src: '/hero.glb', animations: ['Idle', 'Run'] }
{ type: 'grid',    id: 'floor', size: 20, step: 0.5, lineWidth: 0.002 }
{ type: 'cube',    id: 'box',   size: 1, texture: 'brick' }
{ type: 'sphere',  id: 'ball',  segments: 24, texture: 'brick' }
{ type: 'cylinder',id: 'post',  segments: 16 }
{ type: 'cone',    id: 'tip',   segments: 12 }
{ type: 'plane',   id: 'wall',  width: 4, height: 3, texture: 'brick' }
{ type: 'mesh',    id: 'custom', positions: [...], uvs: [...] }
{ type: 'composite', id: 'campfire', parts: [...] }

// 2D
{ type: 'spritesheet', id: 'ui',    src: '/ui.png', frameWidth: 32, frameHeight: 32 }
{ type: 'texture',     id: 'brick', src: '/brick.png' }
```

### Prefabs

Prefabs are the parsed result after `load()` resolves. Each spec variant maps to a concrete prefab type with the data a renderer needs:

| Spec | Prefab | Key fields |
|------|--------|------------|
| `gltf` | `GltfPrefab` | `.parsed` (ParsedGltf), `.animations`, `.jointCount`, `.skinnedPartCount`, `.loadAnimations()` |
| `grid` | `GridPrefab` | `.size`, `.step`, `.lineWidth` |
| `cube` | `CubePrefab` | `.size`, `.texture?`, `.uv` |
| `sphere` | `SpherePrefab` | `.segments`, `.texture?` |
| `cylinder` | `CylinderPrefab` | `.segments`, `.texture?` |
| `cone` | `ConePrefab` | `.segments`, `.texture?` |
| `plane` | `PlanePrefab` | `.width`, `.height`, `.texture?` |
| `mesh` | `MeshPrefab` | `.positions`, `.normals?`, `.uvs?`, `.indices?`, `.texture?` |
| `composite` | `CompositePrefab` | `.parts` |
| `spritesheet` | `SpritesheetPrefab` | `.parsed`, `.frameCount` |
| `texture` | `TexturePrefab` | `.parsed` (HTMLImageElement) |

All prefabs carry `.metadata` (preserved from the spec) and optionally `.hitbox`.

## Implementing a backend

Subclass the base renderer. If the user provides an `AssetBucket`, walk it to size GPU buffers and upload parsed prefabs — the bucket is passed as `prefabs` in options and exposed as `_prefabs` on the base renderer.

```typescript
import {
  Base3DRenderer,
  type AssetBucket,
  type Renderer3DOptions,
} from 'murow';

class MyRenderer extends Base3DRenderer {
  constructor(canvas, options: Renderer3DOptions & { prefabs?: AssetBucket }) {
    super(canvas, options);
  }
  async init() {
    const bucket = this._prefabs as AssetBucket | undefined;
    if (bucket) {
      await bucket.load();
      for (const prefab of bucket.prefabs.entries()) {
        // Upload each parsed prefab to your GPU primitives
      }
    }
  }
  render(alpha) { /* draw */ }
  destroy() { /* cleanup */ }
}
```

See [`@murow/webgpu`](../../../webgpu) for a full reference implementation.

## Picking / Raycasting

Abstract contracts for hit-testing (mouse, touch, controller ray) against spawned instances. Backends implement the concrete ray math for their scene representation.

```typescript
import { Raycast, type RaycastHit, type RaycastOptions } from 'murow';

// Backend-provided (e.g. WebGPU3DRenderer implements this internally)
const picker: Raycast<InstanceHandle, [number, number, number]> = renderer.raycast;

// Per-frame: feed input, then query
picker.update(input);

const hit = picker.hit({ filter: h => h.prefabId === 'enemy' });
if (hit) {
  console.log(hit.handle.id, hit.point, hit.part);
  //        ^ InstanceHandle      ^ x,y,z   ^ hitbox part name or null
}

// All hits sorted by distance
const hits = picker.hitAll({ maxDistance: 50 });

// Memoized query — stable across the frame until disposed
const memo = picker.memo({ filter: h => !h.skinned });
console.log(memo.first?.handle.id, memo.hits.length);
memo.dispose();

renderer.clearMemos(); // or call on the renderer directly
```

### Types

| Type | Description |
|------|-------------|
| `RaycastHit<H, Point>` | A single hit: `handle`, `distance`, `point`, `part` (hitbox part name or null) |
| `RaycastOptions<H>` | `filter` callback and `maxDistance` limit |
| `Raycast<H, Point>` | Abstract base: `update()`, `hit()`, `hitAll()`, `memo()`, `clearMemos()` |
| `RaycastMemo<H, Point>` | Cached query result: `hits` array, `first` hit, `dispose()` |

## Types

- `SpriteHandle` — zero-alloc handle for reading/writing sprite data (x, y, rotation, scale, opacity, etc.)
- `SpritesheetHandle` — loaded spritesheet with UV lookups
- `SpriteOptions` — options for creating a sprite (sheet, position, layer, tint, etc.)
- `Camera2DState` / `Camera3DState` — camera properties consumed by renderers
- `ClearColor` — `[r, g, b, a]` tuple
- `StringOr<T>` — `T | (string & {})`. Accept any string at runtime; autocomplete known literals.

# Renderer

Renderer-agnostic primitives for any rendering backend (WebGPU, PixiJS, Three.js, …). This module holds the **abstract contracts** that backends implement and the **asset pipeline** (parsing, animation, prefab registry) that they consume.

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
├── prefab-bucket/     — typed asset registry
│   ├── index.ts           (BasePrefabBucket + types)
│   ├── concrete.ts        (PrefabBucket — 2D/3D with prewired parsers)
│   ├── specs.ts           (spec/prefab unions, PrefabFor mapping)
│   └── parsers.ts         (registered spec → prefab parsers)
├── math.ts            — TRS/mat4 math (zero-alloc)
└── types.ts           — SpriteHandle, SpritesheetHandle, Camera*State, etc.
```

Everything here is **pure CPU**: no GPU, no canvas, no device. The webgpu (or any) backend is responsible for the upload step.

## PrefabBucket

The user-facing entry point. Declare every spawnable asset up-front, parallel-load, look up by id with full type safety.

```typescript
import { PrefabBucket } from 'murow';

const bucket = new PrefabBucket('3d')
  .add({
    type: 'gltf',
    id: 'hero',
    url: '/hero.glb',
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

### Lifecycle

1. **`add()` / `addAll()`** — collect specs (sync, no I/O). Chainable.
2. **`load()`** — resolves all async work (fetch, parse) in parallel. Frozen after this.
3. **`get(id)` / `getAllByType(type)`** — typed lookups.

The bucket carries derived stats (joint counts, skinned-part counts, vertex totals) so renderers can self-size their GPU buffers without you having to specify magic numbers.

### Mode argument

- `new PrefabBucket('3d')` — accepts gltf / grid specs
- `new PrefabBucket('2d')` — accepts spritesheet specs

The mode narrows what `add()` accepts and what `get()` returns. Type-safe by construction.

### Metadata

Every spec can carry user-defined `metadata: Record<string, unknown>`. Literal types preserved through to the prefab:

```typescript
.add({ type: 'gltf', id: 'hero', url: '/hero.glb', metadata: { scale: 0.01, hp: 100 } });
//                              bucket.get('hero').metadata is { scale: 0.01, hp: 100 }
```

## Implementing a backend

Subclass the base renderer for your backend, consume a `PrefabBucket` to drive sizing and uploads:

```typescript
import {
  Base3DRenderer,
  parseGltf,
  type PrefabBucket3D,
  type Renderer3DOptions,
} from 'murow';

class MyRenderer extends Base3DRenderer {
  constructor(canvas, options: Renderer3DOptions & { prefabs?: PrefabBucket3D }) {
    super(canvas, options);
    // Read options.prefabs to size buffers, etc.
  }
  async init() {
    // Walk bucket.entries() and upload each parsed prefab to your GPU primitives
  }
  render(alpha) { /* draw */ }
  destroy() { /* cleanup */ }
}
```

See [`@murow/webgpu`](../../../webgpu) for a full reference implementation.

## Types

- `SpriteHandle` — zero-alloc handle for reading/writing sprite data (x, y, rotation, scale, opacity, etc.)
- `SpritesheetHandle` — loaded spritesheet with UV lookups
- `SpriteOptions` — options for creating a sprite (sheet, position, layer, tint, etc.)
- `Camera2DState` / `Camera3DState` — camera properties consumed by renderers
- `ClearColor` — `[r, g, b, a]` tuple
- `StringOr<T>` — `T | (string & {})`. Accept any string at runtime; autocomplete known literals.

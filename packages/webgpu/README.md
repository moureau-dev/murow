# @murow/webgpu

WebGPU 2D/3D rendering backend for murow. Zero-copy instanced rendering powered by **TypeGPU**.

## Installation

Install via the main murow package:

```bash
npm install murow
```

Then import from `murow/webgpu`:

```typescript
import { WebGPU2DRenderer, WebGPU3DRenderer, d, std } from 'murow/webgpu';
```

## Features

### Core
- **TypeGPU integration** — Write type-safe WGSL shaders in TypeScript via [TypeGPU](https://docs.swmansion.com/TypeGPU/)
- **Zero-GC data path** — `Float32Array` buffers, `FreeList` slot allocation, no per-frame objects
- **GPU-side interpolation** — `mix(prev, curr, alpha)` runs in shaders, not on CPU
- **Sparse batching** — Minimal draw calls via layer/sheet sorting (`SparseBatcher`)
- **AssetBucket** — declare textures + prefabs up front, parallel load, typed-id lookups; the renderer self-sizes from the bucket. Lives in [`murow`](../murow/src/renderer) and is consumed by any backend.

### 2D Rendering
- **Sprite rendering** — 1 draw call per spritesheet, regardless of sprite count
- **Custom geometry** — Fluent API for particle systems, lasers, procedural shapes
- **Compute shaders** — Zero-copy GPU physics (see [gpu-particles.ts](../../benchmarks/renderer/programs/gpu-particles.ts))
- **Particle emitter** — CPU-driven particles with gravity, fade, lifetime

### 3D Rendering
- **glTF loading** — `.glb` meshes with textures and skinned animation (via `AssetBucket`)
- **Skeletal animation** — Crossfading, looping, event callbacks; typed animation names
- **Frustum culling** — Automatic per-instance visibility checks
- **Distance-based animation culling** — Skip compute-shader skinning for instances outside `animationCullDistance`
- **Composites** — a `{ type: 'composite', parts: [...] }` spec wires several prefabs into one spawnable instance with baked offsets
- **Instance recycling** — `handle.destroy()` frees slots and bone-matrix blocks; respawns reuse them without growing buffers
- **Grid / cube helpers** — `{ type: 'grid' }` and `{ type: 'cube' }` prefab specs
- **Materials** — `renderer.createMaterial(spec)` with `standard` (lit), `unlit`, `emissive`, and custom `shader` types; per-material uniforms, named textures (mipmapped), `alphaTest` cutout, UV scale/offset, per-material samplers, two-sided normals, and render state (blend modes / depth / cull / colorWrite / depthBias)
- **Camera effects** — an ordered fullscreen post chain on `renderer.camera.effects` (fxaa, vignette, grade, chromatic, scanlines, posterize, motionBlur) plus custom declarative shader effects, rendered through off-screen targets
- **3D particles** — GPU-first `renderer.particles`: emitters, atlas animation, turbulence, additive/alpha materials, per-material `drawIndirect` batching, and camera-frustum emitter culling
- **Shadows** — a directional map from the sun (cached; re-rendered only on change) plus **spot** (up to 4) and **point/cube** (up to 2) shadow maps via `castShadow: true` on a spot/point `LightSpec`. Controls: `renderer.shadows` / `renderer.spotShadows` / `renderer.pointShadows`; `standard` materials PCF-sample them, per-material `shadow: { cast, receive }`
- **Decals** — `renderer.createDecalLayer({ atlas, quad, capacity })` pools instanced quads oriented to a surface normal (blood/scorch/AoE marks), sampling one atlas cell per mark and fading over time; oldest recycled past capacity
- **Resolution cap** — `maxPixelRatio` caps the internal render resolution on HiDPI (scene + post + shadows all scale with it); the single cheapest large perf win

## Usage

<details>
<summary><strong>2D Sprites</strong></summary>

```typescript
import { AssetBucket } from 'murow';
import { WebGPU2DRenderer } from 'murow/webgpu';

const assets = new AssetBucket('2d')
  .prefabs(({ bucket }) => bucket.add({
    type: 'spritesheet',
    id: 'characters',
    src: '/assets/characters.png',
    frameWidth: 32,
    frameHeight: 32,
  }));

await assets.load();

const renderer = new WebGPU2DRenderer(canvas, { assets, maxInstances: 10000 });
await renderer.init();

const player = renderer.addSprite({
  sheet: assets.prefabs.get('characters'),
  sprite: 0,
  position: [400, 300],
});
player.x = 500; // Direct buffer writes
renderer.render(alpha);
```
</details>

<details>
<summary><strong>3D Models (glTF)</strong></summary>

```typescript
import { AssetBucket } from 'murow';
import { WebGPU3DRenderer } from 'murow/webgpu';

const assets = new AssetBucket('3d')
  .prefabs(({ bucket }) => bucket.add({
    type: 'gltf',
    id: 'hero',
    src: '/character.glb',
    animations: ['Idle', 'Run', 'Attack'],
    metadata: { scale: 0.01 },
  }));

await assets.load();

// Renderer sizes its skinned + bone buffers from the bucket — no magic numbers.
const renderer = new WebGPU3DRenderer(canvas, { assets, maxInstances: 100 });
await renderer.init();

const hero = assets.prefabs.get('hero');          // typed as GltfPrefab
const instance = renderer.addInstance({
  prefab: hero,
  position: [0, 0, 0],
  scale: hero.metadata.scale,
});
instance.play?.(hero.animations.Idle, { loop: true, crossfade: 0.15 });

renderer.camera.setPosition(3, 1, 3);
renderer.camera.setTarget(0, 0, 0);
renderer.render(alpha);
```
</details>

<details>
<summary><strong>Materials (3D)</strong></summary>

Create a material after `renderer.init()`. A `shader` material omits `shaders.vertex` to reuse the engine mesh vertex, so the fragment receives `vNormal`, `vColor`, `vUV`, `vWorldPos`.

```typescript
import { d, std } from 'murow/webgpu';

const holo = renderer.createMaterial({
  type: 'shader',
  blend: 'additive',
  depthWrite: false,
  textures: { map: 'flame' },           // texture id from the AssetBucket
  uniforms: { scan: d.f32, tint: d.vec3f },
  defaultUniforms: { scan: 2, tint: [0.35, 0.85, 1] },
  shaders: {
    fragment: (input) => {
      const tex = std.textureSample(textures.map, textures.sampler, d.vec2f(input.vUV.x, input.vUV.y));
      const band = std.saturate(std.sin(input.vWorldPos.y * material.scan) * 0.5 + 0.5);
      const c = std.mul(material.tint, band);
      return d.vec4f(c.x, c.y, c.z, tex.w);
    },
  },
});

const glow = renderer.createMaterial({ type: 'emissive', color: [1, 0.45, 0.1], emissive: 2 });

const orb = renderer.addInstance({ prefab: 'orb', material: holo });
orb.setMaterial(glow.slot + 1);   // slot + 1; 0 is the engine default
orb.setMaterialParams(1.5, 0);    // per-instance custom0 / custom1

holo.uniforms.scan += 0.6;         // live, typed write
holo.setTexture('map', 'smoke');
holo.destroy();
```

Types: `MaterialSpec` (`EngineMaterialSpec | ShaderMaterialSpec`), `MaterialHandle<U>`, `BlendMode` (`'opaque' | 'alpha' | 'additive'`), `CullMode` (`'back' | 'front' | 'none'`), `EngineMaterialSpec`, `ShaderMaterialSpec` — all exported from `murow/webgpu`.
</details>

<details>
<summary><strong>Custom Geometry (TypeGPU Shaders)</strong></summary>

```typescript
import { d, std } from 'murow/webgpu';

const geom = renderer
  .createGeometry('starfield', { maxInstances: 1000, geometry: 'quad' })
  .instanceLayout({
    dynamic: { position: d.vec2f },
    static: { speed: d.f32, phase: d.f32 },
  })
  .uniforms({ time: d.f32 })
  .shaders({
    vertex: {
      out: { brightness: d.f32 },
      fn({ dynamic, statics, uniforms }, input) {
        const pos = dynamic[input.instanceIndex].position;
        const brightness = std.sin(uniforms.time * statics[input.instanceIndex].speed);
        return { pos: d.vec4f(pos.x, pos.y, 0, 1), brightness };
      },
    },
    fragment: {
      fn(input) {
        return d.vec4f(1, 1, 1, input.brightness);
      },
    },
  })
  .build();

geom.addInstance({ position: [0.5, 0.5], speed: 2.0, phase: 0 });
geom.updateUniforms({ time: performance.now() / 1000 });
geom.render();
```

Full example: [starfield.ts](../../benchmarks/renderer/programs/starfield.ts)
</details>

<details>
<summary><strong>GPU Compute (Zero-Copy Physics)</strong></summary>

```typescript
import { d, std } from 'murow/webgpu';

const Particle = d.struct({ posX: d.f32, posY: d.f32, velX: d.f32, velY: d.f32 });

const compute = renderer
  .createCompute('physics', { workgroupSize: 256 })
  .buffers({
    particles: { storage: d.arrayOf(Particle, 10000), readwrite: true },
    config: { uniform: d.struct({ deltaTime: d.f32, gravity: d.f32 }) },
  })
  .shader(({ particles, config }, { globalId }) => {
    const p = particles[globalId.x];
    p.velY = p.velY + config.gravity * config.deltaTime;
    p.posY = p.posY + p.velY * config.deltaTime;
  })
  .build();

const render = renderer
  .createGeometry('particles', { maxInstances: 10000, geometry: 'quad' })
  .instanceLayout({ dynamic: { posX: d.f32, posY: d.f32, velX: d.f32, velY: d.f32 } })
  .fromCompute(compute, 'particles') // Zero-copy binding
  .build();

compute.dispatch(10000);
render.render(); // GPU → GPU, no CPU involvement
```

Full example: [gpu-particles.ts](../../benchmarks/renderer/programs/gpu-particles.ts)
</details>

## API Reference

This package exports **only** WebGPU-specific concrete renderers and GPU helpers.
Renderer-agnostic primitives (`PrefabBucket`, parsers, skeletal animation,
spritesheet helpers) live in [`murow`](../murow/src/renderer) and are imported
from `'murow'`.

### Renderers
- [`WebGPU2DRenderer`](./src/2d/renderer.ts) — Sprite renderer with batching and interpolation
- [`WebGPU3DRenderer`](./src/3d/renderer.ts) — Mesh renderer with glTF, skinning, frustum culling

### Geometry & Compute
- [`GeometryBuilder`](./src/geometry/geometry-builder.ts) — Custom instanced geometries with TypeGPU shaders
- [`ComputeBuilder`](./src/compute/compute-builder.ts) — GPU compute kernels with buffer management

### Materials (3D)
- `WebGPU3DRenderer.createMaterial(spec)` — `standard` (lit), `unlit`, `emissive`, and custom `shader` materials; returns a typed `MaterialHandle<U>` (`slot`, `uniforms`, `setTexture`, `destroy`)
- `MaterialSpec` / `EngineMaterialSpec` / `ShaderMaterialSpec` / `BlendMode` / `CullMode` — material spec types, exported from `murow/webgpu`

### Shadows
- [`ShadowSystem`](./src/3d/renderer/shadows/shadow-system.ts) — directional shadow map control (`renderer.shadows`): `enabled`, `softness`, `bias`, `distance`, `resolution`; `renderer.setShadowResolution(px)` is an alias
- Per material: `shadow: { cast?: boolean; receive?: boolean }` (transparent materials never cast)

### Decals
- [`DecalLayer`](./src/3d/renderer/decals/decal-layer.ts) — `renderer.createDecalLayer({ atlas, quad, capacity })`; `spawn(x,y,z,nx,ny,nz,{cell,size})` places a pooled, atlas-sampled, time-faded mark (backed by core `RingStore`)

### Camera effects
- [`CameraEffectStack`](./src/3d/renderer/camera-effects/stack.ts) — off-screen targets + ping-pong fullscreen passes
- `CameraEffect` / `CameraEffectList` / `CameraEffectSpec` — the `renderer.camera.effects` API (`add`/`set`/`remove`), built-in + custom shader effects

### Camera
- [`Camera2D`](./src/camera/camera-2d.ts) — Orthographic camera with pan/zoom
- [`Camera3D`](./src/camera/camera-3d.ts) — Perspective camera with FPS controls and `effects`

### Animation
- [`MorphAnimation`](./src/3d/morph-animation.ts) — Morph target animation (GPU buffer write path)
- [`AnimationController`](./src/2d/animation.ts) — 2D spritesheet animation
- `SkeletalAnimation` lives in [`murow`](../murow/src/renderer/gltf) — CPU-side bone evaluation, renderer-agnostic

### Utilities
- [`SpriteAccessor`](./src/2d/sprite-accessor.ts) — Direct buffer access for sprites
- [`ParticleEmitter`](./src/particle/emitter.ts) — CPU 2D particle system
- [`ParticleSystem3D`](./src/3d/particles/particle-system-3d.ts) — GPU-first 3D particles (`renderer.particles`)
- [`Spritesheet`](./src/spritesheet/spritesheet.ts) — GPU-bound texture atlas (built from a parsed bucket prefab)
- `d` / `std` — TypeGPU data types and standard library (re-exported)

## Architecture

**WebGPU2DRenderer**
```
TypeGPU root → Pipelines → Bind Groups
  ├─ Float32Array × 2 (dynamic + static instance data)
  ├─ FreeList (slot allocation)
  ├─ SparseBatcher (layer/sheet bucketing)
  ├─ GPU index buffer (sparse → contiguous mapping)
  └─ Spritesheets (texture + UV management)
```

**WebGPU3DRenderer**
```
TypeGPU root → Pipelines → Bind Groups
  ├─ Mesh data (vertices, indices, normals, UVs)
  ├─ Skin data (joints, weights, inverse bind matrices)
  ├─ Animation clips (keyframes, interpolation)
  ├─ Frustum culling (per-instance visibility)
  └─ Grid helpers (debug visualization)
```

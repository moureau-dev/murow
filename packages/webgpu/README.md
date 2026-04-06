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

### 2D Rendering
- **Sprite rendering** — 1 draw call per spritesheet, regardless of sprite count
- **Custom geometry** — Fluent API for particle systems, lasers, procedural shapes
- **Compute shaders** — Zero-copy GPU physics (see [gpu-particles.ts](../../benchmarks/renderer/programs/gpu-particles.ts))
- **Particle emitter** — CPU-driven particles with gravity, fade, lifetime

### 3D Rendering
- **glTF loading** — `.glb` meshes with textures and skinned animation
- **Skeletal animation** — Crossfading, looping, event callbacks
- **Frustum culling** — Automatic per-instance visibility checks
- **Grid helpers** — `createGrid()` for debug visualization

## Usage

<details>
<summary><strong>2D Sprites</strong></summary>

```typescript
import { WebGPU2DRenderer } from 'murow/webgpu';

const renderer = new WebGPU2DRenderer(canvas, { maxSprites: 10000 });
await renderer.init();

const sheet = await renderer.loadSpritesheet({
  image: '/assets/characters.png',
  frameWidth: 32,
  frameHeight: 32,
});

const player = renderer.addSprite({ sheet, sprite: 0, x: 400, y: 300 });
player.x = 500; // Direct buffer writes
renderer.render(alpha);
```
</details>

<details>
<summary><strong>3D Models (glTF)</strong></summary>

```typescript
import { WebGPU3DRenderer } from 'murow/webgpu';

const renderer = new WebGPU3DRenderer(canvas, { maxModels: 100 });
await renderer.init();

const model = await renderer.loadGltf('/character.glb', {
  animations: ['Idle', 'Run', 'Attack']
});

const instance = renderer.addInstance({ model, x: 0, y: 0, z: 0, scaleX: 0.01 });
instance.play?.('Idle', { loop: true, crossfade: 0.15 });

renderer.camera.setPosition(3, 1, 3);
renderer.camera.setTarget(0, 0, 0);
renderer.render(alpha);
```
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

### Renderers
- [`WebGPU2DRenderer`](./src/2d/renderer.ts) — Sprite renderer with batching and interpolation
- [`WebGPU3DRenderer`](./src/3d/renderer.ts) — Mesh renderer with glTF, skinning, frustum culling

### Geometry & Compute
- [`GeometryBuilder`](./src/geometry/geometry-builder.ts) — Custom instanced geometries with TypeGPU shaders
- [`ComputeBuilder`](./src/compute/compute-builder.ts) — GPU compute kernels with buffer management

### Animation
- [`SkeletalAnimation`](./src/3d/skeletal-animation.ts) — Skinned mesh animation (glTF)
- [`MorphAnimation`](./src/3d/morph-animation.ts) — Morph target animation (glTF)
- [`AnimationController`](./src/2d/animation.ts) — 2D spritesheet animation

### Camera
- [`Camera2D`](./src/camera/camera-2d.ts) — Orthographic camera with pan/zoom
- [`Camera3D`](./src/camera/camera-3d.ts) — Perspective camera with FPS controls

### Utilities
- [`SpriteAccessor`](./src/2d/sprite-accessor.ts) — Direct buffer access for sprites
- [`ParticleEmitter`](./src/particle/emitter.ts) — CPU particle system
- [`Spritesheet`](./src/spritesheet/spritesheet.ts) — Texture atlas management
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

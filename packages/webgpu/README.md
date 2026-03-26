# @murow/webgpu

WebGPU 2D/3D rendering backend for murow. Instanced rendering, zero-GC, TypeGPU under the hood.

## Features

- GPU instanced rendering — 1 draw call per spritesheet, regardless of sprite count.
- Zero-GC data path — flat `Float32Array` buffers, `FreeList` slot allocation, no per-frame objects.
- GPU-side interpolation — `mix(prev, curr, alpha)` runs in the shader, not per-sprite on CPU.
- TypeGPU TGSL shaders — type-safe shader authoring, no raw WGSL strings.
- Sparse batching — sprites sorted by layer and spritesheet via `SparseBatcher`, draw calls minimized.
- GPU index buffer — only active sprites are drawn, empty slots skipped via indirection.
- Camera system — orthographic 2D and perspective 3D, resize-aware.
- Custom geometry builder — fluent API for instanced particle systems, lasers, etc.
- Particle emitter — CPU-driven with gravity, fade, lifetime, direction, deterministic PRNG.

## Usage

```typescript
import { WebGPU2DRenderer, d } from '@murow/webgpu';

const renderer = new WebGPU2DRenderer(canvas, {
    maxSprites: 10000,
    clearColor: [0.1, 0.1, 0.1, 1],
});
await renderer.init();

const sheet = await renderer.loadSpritesheet({
    image: '/assets/characters.png',
    frameWidth: 32,
    frameHeight: 32,
});

const player = renderer.addSprite({ sheet, sprite: 0, x: 400, y: 300 });

// Game loop — just write floats, GPU does the rest
player.x = 500;
player.y = 250;
player.rotation = Math.PI / 4;

renderer.render(alpha);
```

## API

- `WebGPU2DRenderer` — instanced 2D sprite renderer with batching and interpolation.
- `WebGPU3DRenderer` — instanced 3D mesh renderer with GLTF loading, frustum culling, and morph animation.
- `SpriteAccessor` — zero-alloc handle for reading/writing sprite data directly into typed arrays.
- `Camera2D` / `Camera3D` — orthographic and perspective cameras.
- `GeometryBuilder` — fluent builder for custom instanced geometries with TypeGPU shaders.
- `ParticleEmitter` — CPU-driven particle system backed by the 2D renderer.
- `d` / `std` — re-exported from TypeGPU for shader authoring.

## Architecture

```
WebGPU2DRenderer
├── TypeGPU root (device, pipelines, bind groups)
├── Float32Array × 2 (dynamic + static instance data)
├── FreeList (slot allocation)
├── SparseBatcher (layer/sheet bucketing)
├── GPU index buffer (sparse → contiguous mapping)
├── Camera2D (orthographic matrix)
└── Spritesheets (texture + UV management)
```

## Benchmarks

Coming soon. (but it is already way better than pixi!)

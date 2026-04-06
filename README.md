# Murow

Monorepo for the murow game engine — a lightweight TypeScript framework for server-authoritative multiplayer games with WebGPU rendering.

## Packages

- **[murow](./packages/murow)** — Core game engine (ECS, networking, protocol, game loop)
- **[murow/webgpu](./packages/webgpu)** — WebGPU 2D/3D renderer (bundled with murow)

## Installation

```bash
npm install murow
```

The WebGPU renderer is **included by default**:

```typescript
import { GameLoop, World, defineComponent } from 'murow';
import { WebGPU2DRenderer, WebGPU3DRenderer, d } from 'murow/webgpu';
```

## Quick Examples

<details>
<summary><strong>3D glTF Models with Animation</strong></summary>

```typescript
import { GameLoop } from 'murow';
import { WebGPU3DRenderer } from 'murow/webgpu';

const renderer = new WebGPU3DRenderer(canvas, { maxModels: 100 });
await renderer.init();

const model = await renderer.loadGltf('/character.glb', {
  animations: ['Idle', 'Run']
});

const instance = renderer.addInstance({
  model,
  x: 0, y: 0, z: 0,
  scaleX: 0.01, scaleY: 0.01, scaleZ: 0.01
});

instance.play?.('Idle', { loop: true });

renderer.camera.setPosition(3, 1, 3);
renderer.camera.setTarget(0, 0, 0);

const loop = new GameLoop({ tickRate: 20, type: 'client' });
loop.events.on('render', ({ alpha }) => renderer.render(alpha));
loop.start();
```
</details>

<details>
<summary><strong>GPU Compute + Zero-Copy Rendering</strong></summary>

```typescript
import { WebGPU2DRenderer, d, std } from 'murow/webgpu';

const renderer = new WebGPU2DRenderer(canvas);
await renderer.init();

const Particle = d.struct({
  posX: d.f32, posY: d.f32,
  velX: d.f32, velY: d.f32,
  life: d.f32
});

// Physics runs on GPU
const compute = renderer
  .createCompute('physics', { workgroupSize: 256 })
  .buffers({
    particles: { storage: d.arrayOf(Particle, 10000), readwrite: true },
    config: { uniform: d.struct({ deltaTime: d.f32, gravity: d.f32 }) }
  })
  .shader(({ particles, config }, { globalId }) => {
    const p = particles[globalId.x];
    p.velY = p.velY + config.gravity * config.deltaTime;
    p.posY = p.posY + p.velY * config.deltaTime;
  })
  .build();

// Render directly from compute buffer (zero-copy)
const render = renderer
  .createGeometry('particles', { maxInstances: 10000, geometry: 'quad' })
  .instanceLayout({ dynamic: { posX: d.f32, posY: d.f32, velX: d.f32, velY: d.f32, life: d.f32 } })
  .fromCompute(compute, 'particles')
  .build();

compute.dispatch(10000);
render.render(); // GPU → GPU, no CPU overhead
```

Full example: [benchmarks/renderer/programs/gpu-particles.ts](./benchmarks/renderer/programs/gpu-particles.ts)
</details>

## Documentation

- [Murow Core Package](./packages/murow/README.md) — ECS, networking, protocol, game loop
- [WebGPU Renderer Package](./packages/webgpu/README.md) — 2D/3D rendering, compute shaders, TypeGPU

## Development

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun run test

# Publish (runs tests + builds)
bun run pub
```

## License

MIT

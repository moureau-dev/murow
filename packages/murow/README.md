# Murow

A lightweight TypeScript game engine for server-authoritative multiplayer games.

## Installation

```bash
npm install murow
```

## Usage

```typescript
import { FixedTicker, EventSystem, BinaryCodec, generateId, lerp, PrefabBucket } from 'murow';
// or
import { FixedTicker } from 'murow/core';
import { WebGPU2DRenderer } from 'murow/webgpu';
```

## Modules

### [Core](./src/core) — Low-level utilities and systems
- [`BinaryCodec`](./src/core/binary-codec) — Schema-driven binary serialization
- [`PooledCodec`](./src/core/pooled-codec) — Object-pooled binary codec with array support
- [`EventSystem`](./src/core/events) — High-performance event handling
- [`FixedTicker`](./src/core/fixed-ticker) — Deterministic fixed-rate update loop
- [`Driver`](./src/core/driver) — Event-driven update orchestration
- [`generateId`](./src/core/generate-id) — Cryptographically secure ID generation
- [`lerp`](./src/core/lerp) — Linear interpolation utility
- [`NavMesh`](./src/core/navmesh) — Pathfinding with dynamic obstacles
- [`IntentTracker` & `Reconciliator`](./src/core/prediction) — Client-side prediction
- [`InputTracker`](./src/core/input) — Cross-platform input state tracking
- [`FreeList`](./src/core/free-list) — Slot allocator for reusable handles
- [`SparseBatcher`](./src/core/sparse-batcher) — Layer/sheet bucketing for batched rendering
- [`SimpleRNG`](./src/core/simple-rng) — Seedable deterministic random number generator
- [`Ray2D` / `Ray3D`](./src/core/ray) — Zero-allocation ray intersection tests (segment, circle/sphere, AABB, plane, triangle)

### [ECS](./src/ecs) — Entity Component System
High-performance ECS with **SoA (Structure of Arrays)** storage, bitmask queries, and zero-allocation hot paths:
- `World` — Manages entities and components
- `defineComponent` — Define typed components with binary schemas
- `EntityHandle` — Fluent chainable entity API

### [Game](./src/game) — Game loop abstractions
- [`GameLoop`](./src/game/loop) — Client/server tick loop with `sync` / `pre-tick` / `tick` / `post-tick` / `render` phases, plus input tracking and frame interpolation

### [Protocol](./src/protocol) — Networking primitives
Minimalist networking primitives:
- [`IntentRegistry`](./src/protocol/intent) — Type-safe intent codec registry
- [`SnapshotCodec` & `SnapshotRegistry`](./src/protocol/snapshot) — Binary encoding for state deltas
- [`Snapshot<T>`](./src/protocol/snapshot) — Delta-based state updates
- [`applySnapshot()`](./src/protocol/snapshot) — Deep merge snapshots into state
- [`RpcRegistry` & `defineRpc()`](./src/protocol/rpc) — Type-safe RPC definitions

### [Network](./src/net) — Transport-agnostic networking
Transport-agnostic client/server abstractions:
- `ServerNetwork` — Multiplayer game server with per-peer snapshot registries
- `ClientNetwork` — Game client with intent/snapshot handling
- `TransportAdapter` — Pluggable transport interface
- `BunWebSocketTransport` — Bun WebSocket implementation (reference)

Key features:
- **Per-peer snapshot registries** for fog of war and interest management
- **Transport agnostic** — works with WebSocket, WebRTC, UDP, etc.
- **Type-safe** protocol integration with `IntentRegistry` and `SnapshotRegistry`

### [Renderer](./src/renderer) — Abstract renderer interfaces + asset pipeline
Renderer-agnostic primitives consumed by any backend (`@murow/webgpu`, future PixiJS, Three.js, …).
- `BaseRenderer` / `Base2DRenderer` / `Base3DRenderer` — abstract contracts
- [`PrefabBucket`](./src/renderer/prefab-bucket) — typed registry for spawnable assets. Declare → load → typed lookup; the renderer self-sizes from the bucket
- `parseGltf` / `parseSpritesheet` — pure CPU parsers (no GPU, no canvas)
- `SkeletalAnimation` — CPU-side bone evaluation for skinned meshes

### [WebGPU](./src/../webgpu) — WebGPU rendering backend
The WebGPU renderer is bundled with murow and accessible via `murow/webgpu`:

```typescript
import { WebGPU2DRenderer, WebGPU3DRenderer } from 'murow/webgpu';
```

See [WebGPU README](../webgpu/README.md) for full documentation.

### [Netcode](./src/../netcode) — Multiplayer layer
Opinionated multiplayer layer built on the `Protocol` and `Network`
primitives above. Adds snapshot-based state sync, client-side prediction
with rollback, jitter interpolation, server-pushed entity assignment,
and spatial-interest plugins.

```typescript
import { GameServer, GameClient, defineIntents, definePredictions } from 'murow/netcode';
```

See [Netcode README](../netcode/README.md) for full documentation. If
its opinions don't fit, drop down to the `Protocol` and `Network`
primitives directly.

## Building

```bash
npm install
npm run build
```

## License

MIT

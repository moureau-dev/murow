@AGENTS.md

# Verified pitfalls

Facts checked against the source on 2026-11-24. They override the docs where
the two disagree. `TODO.md` tracks each one by id; when you fix one, update
this file and the `TODO.md` entry.

## Trust the source, not the docs

Most Markdown in this repo has drifted from the code, including `llms.txt`.
Many doc examples throw or do not compile (`TODO.md` DOC1 to DOC6). Before you
copy an API from a doc, confirm it in the source or run it.

- Check what a barrel exports by running it:
  `cd packages/webgpu && bun -e 'import * as m from "./src/index.ts"; console.log(Object.keys(m))'`.
- Reproduce a suspected bug with a throwaway script in `/tmp` that imports repo
  files by absolute path. Run it with `bun`. Never put scratch files in the repo.
- `murow/webgpu` exports only `d`, `std`, `runtime`, `WebGPU2DRenderer`,
  `WebGPU3DRenderer`, and `OcclusionTrackerImpl`. Cameras, handles, and manager
  types come from `murow/renderer/managers` (`Handles`) and
  `murow/renderer/managers/runtime`.
- `IntentTracker`, `Reconciliator`, `PooledArrayEncoder`, `murow/net/ecs`,
  `renderer.compute`, `renderer.createCompute`, `GameLoop.on`, and the
  `ServerNetwork`/`ClientNetwork` RPC methods (`onRpc`, `sendRpcBroadcast`) do
  not exist. Use `PredictionLog`, `Reconciler`, `PooledCodec.array`,
  `loop.events.on`, and `GameServer.sendRpc(peer, name, payload)`,
  `broadcastRpc`, and `on('rpc')`.

## ECS

- Do not despawn or remove components inside a system or a `world.query()`
  loop. Iteration swap-pops a cached array and skips entities (H3). Collect
  ids, then despawn after the loop.
- Despawn is immediate. The next `spawn()` can return the same id while it is
  still listed in `getDespawned()` (H44).
- Only `f32`, `i32`, `u32`, `u16`, and `u8` fields store correctly. `i8`, `i16`,
  `f16`, `f64`, and `bool` corrupt values (H2).
- `defineComponent(name, { schema })` throws unless `sync` is also given. Pass
  the bare schema, or both keys.
- `EntityHandle` writes skip dirty tracking and the alive check (H4). Use
  `world.update` or `world.fields()` when the change must replicate.
- A component registered in two `World`s corrupts the first (H1). This affects
  tests that run a client and a server world in one process.

## Game loop and determinism

- `GameLoop` events are on `loop.events`. `new GameLoop` requires `type`.
- The `skip` event never fires: `FixedTicker` drops `onTickSkipped` (H10).
- `ctx.tick` differs between client and server. Do not branch on it in a
  prediction (H18).
- `ctx.rng` is reseeded per intent from the tick, entity, sequence, and
  `rngSeed`. Client prediction and client replay agree. Client and server agree
  only when their entity ids match (H18). `rngSeed` must match on both sides.

## Netcode

- A throwing intent handler aborts the whole server tick (H19). Handlers must
  not throw.
- `client.use(plugin)` ignores anything that is not a prediction (H45).
- The Bun WebSocket client transport never fires `connected` (H22). Use the
  browser transport or the in-memory and simulated transports in tests.
- An unknown interest name admits every entity (H21). Check spelling.

## Renderer

- Shader materials take `fragment: { fn }`, not a bare function. A bare
  function throws at `createMaterial`.
- Occlusion culling is off unless the `occlusion` option is passed.
- Instance handle setters do not check that the handle is alive. A stale handle
  moves whatever reuses the slot (H46).
- Sphere prefabs are always unit radius; a `radius` key is dropped silently
  (H50). `renderer.shadows.directional.anchorStep` is internal and does nothing
  when assigned.
- Textures are never freed, including by `renderer.destroy()` (A1).
- `bucket.get('typo')` compiles. Unknown ids throw at runtime.

## Shaders (`murow/gpu`)

Read `packages/murow/src/gpu/README.md` first. In short:

- Engine shaders are `GpuShader.vertex`, `.fragment`, and `.compute`, with
  options first and a body `(input, bindings)` second. `GpuProgram.link` parses
  the body's source text at runtime; the body never runs as JavaScript.
- A body sees only its two parameters, `d`, `std`, and the names listed in
  `helpers`. Closed-over JavaScript values are invisible to the parser.
- Vertex bodies must use a block body that returns the output record. A
  parenthesised object literal is rejected.
- Write `d.f32(0)` where the type matters. Bundlers print `0.0` as `0`, which
  becomes an `i32`.
- Avoid ternaries (wrong `select` argument order) and `continue` inside `for`
  or `do` (skips the update, hangs the GPU) until H33 is fixed.
- Only `compileProgram` in `murow/webgpu` repairs the emitter's `let` locals.
  `GpuBackend.compile` alone emits invalid WGSL for mutable locals.

## Verifying rendering

Headless Chromium on a host without a GPU starts a WebGPU page but presents a
blank canvas. A page reaching its "running" state with no console errors is
the most this host can confirm. Say so instead of claiming a visual check
passed (R2).

## Repository hygiene

- `packages/website/public/docs/` is generated by the website `prebuild`. Edit
  the root `docs/`.
- `TODO.md` is the backlog. Keep its ids stable; do not renumber.

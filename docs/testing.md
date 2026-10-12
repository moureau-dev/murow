# Testing murow games

murow is renderer-independent where it matters: the ECS, game loop, protocol, and netcode are pure CPU and run in plain Bun with no GPU, no canvas, and no wall clock you don't control. This guide is the practical companion to the [determinism guide](./determinism.md): it shows how the engine tests itself, how to drive a client and server over an in-process or simulated network, and how to assert on world state after N ticks instead of on frames.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **Test with `bun test ./src`** from inside a package. Use `bun:test` and co-locate `*.test.ts` next to the implementation.
2. **Keep tests headless.** ECS, protocol, and netcode need no device; only the WebGPU backend does.
3. **Use `MemoryServerTransport` for instant links** (microtask delivery, no clock) and `VirtualServerTransport` when you need latency, jitter, loss, or reorder.
4. **Own the clock.** `manual-client` / `manual-server` loops with `loop.step(dt)`; nothing happens until you step.
5. **Advance the virtual network explicitly.** `vnet.advance(ms)` delivers due packets; `vnet.pending()` should be 0 before you assert.
6. **Seed everything.** `new SimpleRNG(seed)` for test randomness; predictions must be deterministic (no `Math.random`/`Date.now`).
7. **Assert on world state after N ticks**, not on interpolation frames. Set the client interpolation `delay` to `0`.
8. **Test shader lowering purely.** `compileProgram` emits WGSL text with no device. It checks codegen, not a real adapter compile.

## The model

Three layers, three testing strategies:

- **Pure core** (`murow/core`, ECS, protocol, `murow/renderer` contracts): plain functions and typed arrays. Test with `bun test`, no setup.
- **Netcode** (`murow/netcode` over `murow/net` transports): a `GameServer` and one or more `GameClient`s wired to a test transport, stepped on manual loops.
- **WebGPU** (`@murow/webgpu`): the shader DSL lowers to WGSL source with `compileProgram`; that path is pure. Only a real device (`GPUDevice`) needs a GPU.

A test transport is a `ServerTransportAdapter`; `connectClient()` returns `{ client, peerId }` where `client` is the client-side `TransportAdapter`. You own time, so you decide when packets arrive and when ticks run.

```ts
import { MemoryServerTransport } from 'murow/net';

const transport = new MemoryServerTransport();          // instant, no clock
const { client: clientTransport, peerId } = transport.connectClient();
```

`VirtualNetwork` / `VirtualServerTransport` (aliased `Transports.Simulated` / `Transports.SimulatedNetwork`) add latency, jitter, loss, and reorder, and are seedable for reproducible runs.

## Worked examples

### Headless simulation

The ECS is a data store; a system is a function over its fields. No loop, no device, no clock.

```ts
import { describe, test, expect } from 'bun:test';
import { defineComponent, f32 } from 'murow';
import { World } from 'murow/ecs';

const Position = defineComponent('Position', { schema: { x: f32, z: f32 } });

test('moveSystem integrates at a fixed dt', () => {
  const world = new World({ maxEntities: 16, components: [Position] });
  const e = world.spawn();
  world.add(e, Position, { x: 0, z: 0 });

  const dt = 1 / 20;
  const p = world.fields(Position);          // reused bundle, resolved once per test
  p.x[e] += 2 * dt;
  p.z[e] += 1 * dt;

  expect(p.x[e]).toBeCloseTo(0.1);
  expect(p.z[e]).toBeCloseTo(0.05);
});
```

`world.get(e, C)` and `world.query(...)` return reused objects/arrays. Read them and assert immediately, or copy into locals first.

### A client and server over the memory transport

`MemoryServerTransport.send` schedules a microtask, so flush before asserting. This is the pattern the netcode integration tests use.

```ts
import { describe, test, expect } from 'bun:test';
import { f32, defineComponent } from 'murow';
import { World } from 'murow/ecs';
import { GameLoop } from 'murow/game';
import { MemoryServerTransport } from 'murow/net';
import { GameServer, GameClient, defineIntents, defineRpcs, definePredictions, networked } from 'murow/netcode';

const Position = defineComponent('Position', {
  schema: { x: f32, z: f32 },
  sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

async function flush() {
  for (let i = 0; i < 2; i++) await Promise.resolve();   // drain microtasks
}

test('a synced component reaches the client', async () => {
  const intents = defineIntents({ move: { dx: f32, dz: f32 } });
  const rpcs = defineRpcs({});
  const predictions = definePredictions(intents, {
    move: ({ dx, dz }, ctx) => {
      const pos = ctx.fields(Position);
      pos.x[ctx.entity] += dx * ctx.deltaTime;
      pos.z[ctx.entity] += dz * ctx.deltaTime;
    },
  });

  const tickRate = 20;
  const STEP = 1 / tickRate + 0.001;

  const serverWorld = new World({ maxEntities: 16, components: [Position] });
  const serverLoop = new GameLoop({ tickRate, type: 'manual-server' });
  const transport = new MemoryServerTransport();
  const server = new GameServer({
    world: serverWorld, loop: serverLoop, transport,
    protocol: { intents, rpcs },
    snapshot: { rate: tickRate },                          // ship every tick for tight asserts
  });
  server.use(predictions);

  const clientWorld = new World({ maxEntities: 16, components: [Position] });
  const clientLoop = new GameLoop({ tickRate, type: 'manual-client' });
  const { client: clientTransport, peerId } = transport.connectClient();
  const client = new GameClient({
    world: clientWorld, loop: clientLoop, transport: clientTransport,
    protocol: { intents, rpcs },
    strategy: { kind: 'snapshot-interpolation', delay: 0 },  // newest value, no 100ms lag
  });
  client.use(predictions);

  const peer = { peerId, entity: -1 };
  const serverEntity = serverWorld.spawn();
  serverWorld.add(serverEntity, Position, { x: 0, z: 0 });
  server.assignEntity(peer, serverEntity);

  serverLoop.step(STEP);
  await flush();
  clientLoop.step(STEP);

  const localEntity = client.assignedEntity!;
  expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(0);

  client.sendIntent('move', { dx: 1, dz: 0 });             // false until assigned; here it is
  serverLoop.step(STEP);
  await flush();
  clientLoop.step(STEP);

  expect(clientWorld.get(localEntity, Position).x).toBeCloseTo(0.2);
});
```

`client.getPredictionDepth()` returns the number of unacked predictions; `client.on('reconciled', ({ replayed }) => ...)` fires after a rollback replay.

### Simulated latency and loss

`VirtualServerTransport` schedules every packet through a `VirtualNetwork`. Nothing arrives until you call `vnet.advance(ms)`. Pass the same clock to the client via `now` so interpolation and RTT use virtual time.

```ts
import { VirtualNetwork, VirtualServerTransport } from 'murow/net';
import { SimpleRNG } from 'murow';

const vnet = new VirtualNetwork();
const transport = new VirtualServerTransport({
  vnet,
  seed: 0xC0FFEE,                        // fixed seed reproduces the same conditions
  cfg: { baseLatencyMs: 80, jitterMs: 20, lossChance: 0.05, reorderChance: 0.1, reorderSkewMs: 40 },
});

const { client: clientTransport } = transport.connectClient();
const client = new GameClient({
  /* ... */
  now: () => vnet.nowMs(),               // virtual clock, not performance.now()
});

// ...step the server/client loops, then deliver due packets:
vnet.advance(50);
```

`transport.setConfig(cfg)` swaps conditions mid-run (use a lossless config to bootstrap or to drain at the end). `vnet.pending()` reports queued packets; assert it is `0` after draining so post-conditions never read in-flight state.

### Deterministic replay and golden logs

Because predictions are deterministic (seeded `SimpleRNG`, fixed `deltaTime`), a run with the same seed, initial state, and intent stream reproduces byte-for-byte. Record a per-tick sample and compare against a golden sequence.

```ts
import { Timeline } from 'murow/core/timeline';

function hash(world: World, entities: number[]): number {
  let h = 0x811c9dc5;
  const buf = new ArrayBuffer(4), bytes = new Uint8Array(buf), view = new DataView(buf);
  const p = world.fields(Position);
  for (const e of entities) {
    view.setFloat32(0, p.x[e] + p.z[e], true);
    for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h >>> 0;
}

const log = new Timeline<number>(256, 0);   // capacity, no stale-window pruning
for (let tick = 1; tick <= 64; tick++) {
  serverLoop.step(STEP);
  log.record(tick, tick, hash(serverWorld, [serverEntity]));
}

const golden = [/* u32 per tick, committed once */];
expect(Array.from({ length: log.length }, (_, i) => log.at(i).sample)).toEqual(golden);
```

Keep the golden small (a hash, not full state). `Timeline.record(tick, receivedAt, sample)` inserts in tick order and dedups by tick; `at`, `newest`, `oldest`, and `straddle` read it back.

### Lag compensation in a test

`LagCompensation` keeps a ring of binary frames per tick. Mount it, feed it ticks, then `rewind(tick, fn)` to read historical state inside the callback. In a server handler, `ctx.lagCompensated(fn)` does the same rewind.

```ts
import { LagCompensation } from 'murow/netcode';

const plugin = new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] });
plugin.onMount({ world: serverWorld } as any);

for (let t = 1; t <= 8; t++) {
  serverWorld.update(serverEntity, Position, { x: t, z: t * 10 });
  plugin.onTick(serverWorld, 1 / 20);
  serverWorld.clearAllDirty();
}

const seen = plugin.rewind(3, () => ({ ...serverWorld.get(serverEntity, Position) }));
expect(seen.x).toBe(3);                     // live state is restored after the callback
expect(serverWorld.get(serverEntity, Position).x).toBe(8);
```

### WebGPU: shader lowering without a device

`compileProgram` links shader fragments and runs the WGSL backend to a WGSL string. It is pure: no `GPUDevice`, no adapter. Build fragments with the engine material factories and assert on the emitted source. Import `compileProgram` from the WebGPU package's GPU entry (`./gpu` in a co-located test, `packages/webgpu/src/gpu`).

```ts
import { describe, test, expect } from 'bun:test';
import { compileProgram } from './gpu';
import {
  createMeshLayout,
  createEngineMaterialLayout,
  createStandardMaterialFragment,
} from 'murow/renderer/managers/runtime';

test('standard fragment lowers to WGSL', () => {
  const fragment = createStandardMaterialFragment(createMeshLayout(4), createEngineMaterialLayout());
  const { code } = compileProgram([fragment]);
  expect(code).toContain('@fragment');
  expect(code).toContain('fn fs_main(');
  expect(code).toContain('textureSample(');
});
```

This catches DSL and lowering regressions; it does not validate against a real adapter. Code that calls `device.createShaderModule` still needs a device-backed test.

## Gotchas

- **Memory transport is microtask-based.** `send` schedules a `queueMicrotask`; `await Promise.resolve()` a couple of times before asserting. There is no clock to advance.
- **Virtual transport delivers only on `advance`.** `vnet.advance(ms)` (even `advance(0)`) flushes due packets. If `vnet.pending() !== 0`, you are asserting mid-flight.
- **The default `VirtualNetwork` is pristine.** `baseLatencyMs: 0`, no jitter, no loss. Opt into adversity with `cfg`; switch back to a lossless `setConfig` to bootstrap or drain.
- **Client interpolation delay defaults to 100ms.** Set `strategy: { kind: 'snapshot-interpolation', delay: 0 }` when you want the newest snapshot in the world right after a `sync` phase.
- **Manual loops own the clock.** `type: 'manual-client'` / `'manual-server'` never self-drive; call `loop.step(dt)`. Server and client must share the same `tickRate` so `ctx.deltaTime` matches.
- **Snapshots only carry entities the server wrote to since the last tick.** For per-test assertions set `snapshot: { rate: tickRate }`; newcomers still get a baseline pass.
- **`sendIntent` returns `false` until the client is assigned an entity.** Call `server.assignEntity(peer, e)`, step the server, flush, then step the client before sending.
- **Reused objects.** `world.get` / `world.query` / `ctx.fields` are reused; copy out or assert in place. Never retain across another query.
- **`compileProgram` is not a GPU compile.** It emits WGSL text. A typo that a real shader compiler would reject may still pass.
- **Golden logs must be state, not objects.** Hash or copy primitives; a captured reused object mutates under you.

## Quick reference

| want | use |
|---|---|
| run the suite | `bun test ./src` (root: `bun run test`, which builds first) |
| instant client/server link | `new MemoryServerTransport()` + `connectClient()`, flush microtasks |
| deterministic bad network | `new VirtualServerTransport({ vnet, seed, cfg })`, `vnet.advance(ms)` |
| own the clock | `new GameLoop({ type: 'manual-client' \| 'manual-server' })`, `loop.step(dt)` |
| test randomness | `new SimpleRNG(seed)` |
| assert synced state after N ticks | server `snapshot.rate = tickRate`, client `delay: 0`, step + flush |
| prediction depth / rollback | `client.getPredictionDepth()`, `client.on('reconciled', ...)` |
| lag-comp in a handler or test | `LagCompensation` + `plugin.onTick` / `plugin.rewind`, or `ctx.lagCompensated(fn)` |
| shader lowering test | `compileProgram([fragment])`, assert on WGSL text |
| golden / replay log | `Timeline` from `murow/core/timeline` |
| per-tick state hash | small FNV over `Float32Array` fields |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



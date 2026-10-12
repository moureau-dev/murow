# Determinism in murow

murow's multiplayer model is **server-authoritative with client prediction and rollback**. The server applies a client's intent, sends a snapshot, and the client — when the accepted server state disagrees with its prediction — rewinds and **replays** its unacked predictions to catch up. For that replay to land on the same world state as the original prediction, the prediction logic must be **deterministic**: same input + same starting state ⇒ same output.

This guide is the practical reference for staying deterministic. It applies to anything that runs inside `definePredictions` (and any shared code a prediction calls). Server-only `defineHandlers` are not bound by these rules — they can read the clock, do I/O, and use anything.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **No `Math.random()`.** Use `ctx.rng` (a `SimpleRNG`, seeded per tick and replayed identically).
2. **No `Date.now()` / `performance.now()`.** Use `ctx.tick` or `ctx.deltaTime`.
3. **No network, audio, DOM, or file I/O** in a prediction.
4. **No module-level mutable state.** All simulation state lives in components.
5. **Predictions write only `networked()` components.** Writing local-only state lets rollback corrupt the UI.
6. **Run the sim on a fixed timestep** (`GameLoop` `tickRate`, or `FixedTicker`), so `ctx.deltaTime` is constant and replays step identically.
7. **Cross-entity writes use `ctx.markDirty`** so the snapshot pipeline sees them.
8. **Schedule with the loop** — `loop.every(...)` / `loop.in(...)`, never `setTimeout` / `setInterval` / your own `requestAnimationFrame`.

## What breaks determinism (and the fix)

| non-deterministic | why it breaks replay | use instead |
|---|---|---|
| `Math.random()` | different value on replay | `ctx.rng.rand()`, `ctx.rng.int(a, b)` |
| `Date.now()`, `performance.now()` | wall clock differs | `ctx.tick`, `ctx.deltaTime` |
| `setTimeout`/`setInterval`/`requestAnimationFrame` | fires at different times | `GameLoop` `every(…)`/`in(…)` scheduling on the tick |
| `fetch`, `WebSocket`, `localStorage`, DOM reads | external, unordered | server `defineHandlers` / `Rpc`s |
| `AudioManager` side effects | real-time clock | trigger via a networked component the render/audio layer reads |
| module-level `let`/`const` map mutated over time | shared across replays | keep it in a component |
| iterating a `Map`/`Set`/object key order and depending on it | order not guaranteed stable across engines/inserts | iterate the ECS (`world.query`) or a `SlotMap`/`Ring` (insertion order) |
| `async`/`await`/Promises inside a prediction | interleaving, not step-wise | keep predictions synchronous |
| writing non-networked components | rollback restores only networked state → UI desync | write networked only; drive UI from networked state |
| engine-specific transcendentals in the hot path | `Math.sin/cos/exp/pow` can differ by a ULP across engines | prefer `+ - * /` and comparisons; if you need trig, accept the reconciler's tolerance |

## The model

- **`definePredictions(intents, { … })`** — runs on **both** sides. The server applies it authoritatively; the client applies it locally and rolls back on reconcile. This is where the rules apply.
- **`defineHandlers(intents, { … })`** — **server-only**. Damage, spawns, item logic, anything that reads time or does I/O.
- Both can coexist on the same intent.

```ts
// deterministic prediction — same on the client and the server
export const predictions = definePredictions(intents, {
  move: ({ dx, dz }, ctx) => {
    const pos = ctx.fields(Position);           // auto-marks Position dirty
    pos.x[ctx.entity] += dx * MOVE_SPEED * ctx.deltaTime;   // fixed deltaTime
    pos.z[ctx.entity] += dz * MOVE_SPEED * ctx.deltaTime;
  },
  dash: ({ dirX, dirZ }, ctx) => {
    const jitter = ctx.rng.range(-0.1, 0.1);    // seeded, replays identically
    // ...
  },
});
```

The `ctx` a prediction receives is the whole deterministic surface:

```
ctx.world       ctx.entity        ctx.tick        ctx.deltaTime
ctx.rng         ctx.fields(C)     ctx.markDirty(C, entity?)
```

Use `ctx.fields(C)` (not `world.fields`) so the write is auto-marked dirty; when you reach into `ctx.world.fields(C)` directly, call `ctx.markDirty(C, entity)` yourself — including for a *different* entity (`ctx.markDirty(Health, victimId)`).

## Fixed timestep

Determinism starts with a constant `deltaTime`. Run simulation at a fixed `tickRate`:

```ts
const loop = new GameLoop({ tickRate: 20, type: 'client' });  // 20 sim ticks/s, render at refresh
```

Wrap a variable frame delta into fixed steps with `FixedTicker` if you're not using `GameLoop`. Rendering interpolates between the fixed states (`renderer.storePreviousState()` + `render(alpha)`), so a low tick rate still looks smooth — the simulation stays exact.

## Scheduling — never `setTimeout` / `setInterval` / `requestAnimationFrame`

Timers fire on the wall clock, off the tick, at times that don't line up with the simulation or with a replay. Replace them with the loop's tick-bound schedules:

```ts
// setInterval → every
loop.every(2).seconds(spawnWave);          // every 2 seconds
loop.every(500).milliseconds(() => client.ping());
loop.every(3).ticks(applyStatusEffect);    // every 3rd tick

// setTimeout → in (fires once, then its id goes stale)
loop.in(3).seconds(closeGate);
loop.in(250).milliseconds(flashBanner);
loop.in(10).ticks(applyOnce);

loop.clearSchedule(id);     // cancel one
loop.clearSchedules();      // cancel all
```

- The unit resolves to a **tick count** (`count * tickRate`), so schedules fire deterministically — the same tick count always runs the same callbacks, on both sides of a replay.
- `every` realigns from the current tick after a long frame; `in` removes itself once fired.
- `maxSchedules` (default 32) caps the pool at construction; the scheduler is pooled, so schedules don't allocate per fire.

`requestAnimationFrame` is likewise owned by the driver (`type: 'client'`) — never start your own rAF loop; subscribe to `loop.on('render', ({ alpha }) => …)` instead.

## Rollback flow

1. Client sends an intent; applies it locally (a **prediction**) and stores it in an unacked buffer (`prediction.bufferSize`, default 64 — a ring).
2. Server applies intents in sequence order, advances `clientAckTick`, and ships a snapshot.
3. Client reconciles: it discards predictions the server has acknowledged (using `clientAckTick`, not the server tick) and **replays** the remaining unacked predictions from the authoritative state.
4. `client.on('reconciled', ({ rewindTick, replayed }) => …)` fires after the replay.

Because step 3 replays your prediction code, any non-determinism there makes the replay land somewhere else than the original — the exact thing this guide prevents.

## Recording histories — `Timeline`

For replays, lag compensation, and ordered event logs, `murow/core/timeline` gives a bounded, tick-indexed `Timeline`:

```ts
import { Timeline } from 'murow/core/timeline';

const events = new Timeline<string>(/* capacity */ 256, /* window? */ 0);
events.record(ctx.tick, ctx.tick * 1000 / TICK_RATE, 'cast:Q');
events.at(ctx.tick); events.oldest(); events.newest();
```

`murow/netcode` uses rings (`LagCompensation` frame history, prediction buffer, snapshot buffer) for the same purpose; `Timeline` is the standalone, tick-addressable event log.

## Cross-engine note (read this)

Rollback replays run **on the client, on the client's engine**, so a prediction that's deterministic modulo floating-point is self-consistent — the replay reproduces the client's own arithmetic exactly. The **server** (Bun/V8) is a different engine from the client (V8/JSC/SpiderMonkey), so the *same* expression can differ by a ULP. That is tolerated, not fatal: the reconciler smooths small deltas and hard-snaps past `maxDesync`. To keep deltas small:

- Prefer exact-ish arithmetic (`+ - * /`, comparisons, integer math) in critical paths.
- Avoid long FP chains and engine-specific transcendentals in continuous physics.
- Scale to integers where you can (e.g. tick-counted counters, fixed-point speeds).
- Never branch on an FP value being exactly equal if a ULP difference could flip it.

## Gotchas

- **Rules bind predictions, not handlers.** A server `handler` may use `Date.now()`, spawn, and do I/O.
- **`ctx.deltaTime` is only constant if the tick rate is.** Don't change `tickRate` at runtime between server and client.
- **Entity iteration order** is not a determinism source you should rely on. Iterate explicitly (`world.query`, `SlotMap.activeSlots`, `Ring`) and sort if order matters.
- **RNG usage order matters.** If a replay consumes `ctx.rng` a different number of times (e.g. early return), later values drift. Keep RNG draws on the deterministic path only.
- **Reconcile tolerances are a safety net, not a design tool.** `maxDesync`/`snapThreshold` absorb ULP noise; they don't fix genuinely non-deterministic logic.

## Quick reference — use this, not that

| want | use |
|---|---|
| randomness | `ctx.rng` / `new SimpleRNG(seed)` |
| time | `ctx.tick`, `ctx.deltaTime` |
| scheduled work | `loop.every(…)` / `loop.in(…)` (tick-based) |
| reading/writing component data | `ctx.fields(C)` (+ `ctx.markDirty` for cross-entity) |
| simulation rate | fixed `tickRate` / `FixedTicker` |
| ordered event history | `Timeline` (`murow/core/timeline`), `Ring` |
| authoritative-only logic | `defineHandlers` (server) — not bound by these rules |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



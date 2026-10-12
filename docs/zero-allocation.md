# Zero-allocation patterns in murow

murow's data path is built to avoid per-frame allocation. This guide is the practical companion to the container APIs: it shows the toolkit in `murow/core`, the hot-path contracts, and how to wire them into real systems so a game's tick and render loop stay flat.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **Iterate with the ECS.** A system runs over `world.query(...)` and reads/writes fields; it does not drive gameplay from a `Map`/array it keeps outside.
2. **Companion objects live outside the ECS, keyed by entity** — look them up with `SlotStore.get(entity)`.
3. **Pooled data with no object is a `SlotMap` row**, and the slot id is a `u32` field on a component.
4. **Membership sets are `SlotSet`s** you reuse (`add`/`clear`), never a fresh `Set`.
5. **Bounded histories are `Ring`s** (`RingStore`/`RingBuffer`), never a growing array you `shift`.
6. **Dirtiness and despawns come from the World** (`markDirty`/`getDespawned`), not a set you maintain.
7. **Never mutate a query while iterating it** — queue structural changes and apply after.
8. **No `Math.random`, `Date.now`, `performance.now`, or module-level mutable state in predictions** — use `ctx.rng` / `ctx.deltaTime` / `ctx.tick`.

## Hot-path contracts

- `world.get(entity, C)` returns a **reused object**, overwritten by the next `get()`. Read it and copy out; never retain it.
- `world.query(...)` returns a **reused array**, valid only until the next query.
- `world.fields(C)` returns the per-field typed arrays (`pos.x[e]`), resolved once and stable. In netcode predictions/handlers it's `ctx.fields(C)`.

```ts
// yes — the query drives iteration; the object is fetched by entity
const pos = world.fields(Position), face = world.fields(Facing);
for (const e of world.query(MeshTag, Position)) {
  meshes.get(e)?.setPosition(pos.x[e], 0, pos.z[e]).setRotation(0, face.a[e], 0);
}
```

```ts
// no — don't iterate a Map of handles as the driver, and don't world.get() per entity
for (const [e, h] of meshMap) { const p = world.get(e, Position); h.setPosition(p.x, 0, p.z); }
```

## The container toolkit

| container | import | use when | keyed by |
|---|---|---|---|
| **component** | `defineComponent` | numeric per-entity state | entity |
| **`SlotStore<TId, T>`** | `murow/core/slot-map` | a per-entity **object** (renderer handle, DOM node, rigid body) | external id (entity) |
| **`SlotMap`** | `murow/core/slot-map` | a **data row** with no object (a nav path, an agent row) | slot (id === slot) |
| **`SlotSet`** | `murow/core/slot-map` | membership of ids you already own (AOI set, selection, query results) | caller-supplied id |
| **`Ring` / `RingStore` / `RingBuffer`** | `murow/core/ring` | a **bounded history / oldest-eviction pool** (kill feed, lag-comp, input) | position in the ring |
| **`SparseBatcher`** | `murow/core/sparse-batcher` | items bucketed by **two integer keys** into dense arrays (e.g. layer × sheet, cellX × cellY) | two integer keys → slot |
| **`PooledCodec` / `BinaryCodec`** | `murow/core/pooled-codec` | encode/decode without allocating (messages, component sets) | — |
| **`Bucket` (Asset/Prefab)** | `murow/core/bucket` | a typed resource registry (content tables with ids + load lifecycle) | string id |
| **`FreeList`** | `murow/core/free-list` | you want a raw slot allocator and manage the data yourself | slot |
| **`PooledCollection`** (+ `GenerationAllocator`) | `murow/core/collection` | a registry of **versioned handles** where a stale id must fail | versioned id |

Decision axes:
1. **Companion object?** yes → `SlotStore` (by entity) or `PooledCollection` (own registry). no → `SlotMap`.
2. **Must a stale id fail?** yes → `PooledCollection`/generation. no → `SlotMap`/`SlotSet`.
3. **Bounded history with no removal?** → `Ring`.
4. **Grouped by two integer keys for batched processing?** → `SparseBatcher`.

## Engine-served: dirtiness and despawns

Do **not** hand-roll a "dirty set" for state sync. `World` owns a `DirtyTracker` and a `DespawnTracker`:

- `world.add(e, C, …)` and writes to a `networked()` component mark it dirty automatically; `world.markDirty(e, index)` forces it.
- `world.getDespawned()` returns a **reused `Uint32Array`** of entities despawned since the last flush — read it in the same tick, don't retain it.
- `world.flushDespawned()` clears it after you've consumed the list.

`murow/netcode` reads exactly these; a game's snapshot system does too.

## Worked examples

### Numeric per-entity state — components

```ts
import { defineComponent, f32, u8, u16 } from 'murow';

export const Position = defineComponent('Position', { schema: { x: f32, z: f32 } });
export const Facing   = defineComponent('Facing',   { schema: { a: f32 } });
export const Stats    = defineComponent('Stats',    { schema: { hp: u16, maxHp: u16, mana: u16 } });
export const Team     = defineComponent('Team',     { schema: { id: u8 } });
export const MoveStats= defineComponent('MoveStats',{ schema: { speed: f32 } });
// a pooled data-row slot id, stored as a plain field:
export const Order    = defineComponent('Order',    { schema: { path: u32, cursor: u16 } });
// marker components so systems can query a subset cheaply
export const MeshTag  = defineComponent('MeshTag',  { schema: { _pad: u8 } });
export const HudTag   = defineComponent('HudTag',   { schema: { _pad: u8 } });
```

### Pooled data rows (no object) — `SlotMap`

A nav path is waypoints, not an object, so it's a `SlotMap` of rows and the component stores only the slot. Note the **closure-factory** shape: the field bundles are resolved once when the system is built; only `update()` runs per tick. The `world.query(...)` stays inside `update` because membership changes per tick.

```ts
import { SlotMap } from 'murow/core/slot-map';

const MAX_WP = 64;
const paths   = new SlotMap(2048);                       // id === slot, dense
const pathXZ  = new Float32Array(2048 * MAX_WP * 2);      // (x, z) pairs per row
const pathLen = new Uint16Array(2048);
const NO_PATH = 0xffffffff;

function setOrder(world: World, e: Entity, toX: number, toZ: number) {
  const p = world.fields(Position);
  const wp = navmesh.findPath({ x: p.x[e], y: p.z[e] }, { x: toX, y: toZ });
  const slot = paths.add();
  const base = slot * MAX_WP * 2;
  for (let i = 0; i < wp.length; i++) { pathXZ[base + i * 2] = wp[i].x; pathXZ[base + i * 2 + 1] = wp[i].y; }
  pathLen[slot] = wp.length;
  const o = world.get(e, Order); o.path = slot; o.cursor = 1;
}

// build once: fields resolved here
function moveSystem(world: World) {
  const pos   = world.fields(Position);
  const face  = world.fields(Facing);
  const order = world.fields(Order);
  const spd   = world.fields(MoveStats);

  return function update(deltaTime: number) {            // runs every tick
    for (const e of world.query(Order, Position, MoveStats)) {
      const slot = order.path[e];
      if (slot === NO_PATH) continue;
      const base = slot * MAX_WP * 2;
      let rem = spd.speed[e] * deltaTime;
      while (rem > 0 && order.cursor[e] < pathLen[slot]) { /* walk pathXZ -> pos.x/z[e], face.a[e] */ }
      if (order.cursor[e] >= pathLen[slot]) { paths.remove(slot); order.path[e] = NO_PATH; }
    }
  };
}
```

### Per-entity objects — `SlotStore`

Anything with a companion object is keyed by entity. O(1) `get` in a system, dense `forEach` when you want it.

```ts
import { SlotStore } from 'murow/core/slot-map';

const meshes = new SlotStore<Entity, InstanceHandle>(4096, maxEntities);
const bars   = new SlotStore<Entity, HtmlNode>(256, maxEntities);
const bodies = new SlotStore<Entity, RigidBody>(2048, maxEntities);   // e.g. rapier

function spawnEntity(world: World, x: number, z: number) {
  const e = world.spawn();
  world.add(e, MeshTag, { _pad: 0 });
  world.add(e, Position, { x, z });
  meshes.add(e, renderer.instances.add({ prefab, position: [x, 0, z] }));
  world.add(e, HudTag, { _pad: 0 });
  bars.add(e, hudOverlay.spawn({ position: [x, 2, z], lifetime: 1e9 }));
}
function despawn(world: World, e: Entity) {
  meshes.get(e)?.destroy(); meshes.remove(e);
  bars.get(e)?.remove();    bars.remove(e);
  world.despawn(e);
}
```

### Membership sets — `SlotSet`

For "which entities are in this group" — AOI, selection, spatial query results — reuse a `SlotSet` (dense `add`/`clear`, packed iteration). Not for dirtiness (the World owns that).

```ts
import { SlotSet } from 'murow/core/slot-map';

// reusable radius query result set
function makeRadiusQuery(world: World) {
  const pos = world.fields(Position);
  const hits = new SlotSet(world.maxEntities);
  return function query(x: number, z: number, r: number) {
    hits.clear();
    const q = world.query(Position);
    for (let i = 0; i < q.length; i++) {
      const e = q[i]; const dx = pos.x[e] - x, dz = pos.z[e] - z;
      if (dx * dx + dz * dz <= r * r) hits.add(e);
    }
    return hits;   // denseBuffer / size; reused, do not retain
  };
}
```

### Bounded histories — `Ring` / `RingStore` / `RingBuffer`

Append-only, oldest evicted, never allocates after warmup.

```ts
import { RingStore, RingBuffer } from 'murow/core/ring';

// kill feed / floating text pool — oldest recycled
const feed = new RingStore({ capacity: 16, create: () => ({ text: '', t: 0 }) });
feed.push().text = 'First blood';

// per-tick fixed-stride records — lag-comp, prediction, snapshots
const frames = new RingBuffer({ capacity: 64, stride: 256 });
frames.write(view => encodeState(view));
```

`murow/netcode` uses exactly these internally: `LagCompensation` keeps a ring of preallocated frames; the client keeps rings of unacked predictions and received snapshots. The decal pool is a `RingStore`.

### Bucketing — `SparseBatcher`

Two integer keys → dense `Uint32Array` buckets, allocated lazily. The sprite renderer uses it for `(layer, sheet)`; reuse it for any two-key grouping (e.g. a spatial grid `(cellX, cellZ)` → entities) so you never build a `Map<key, array>` per frame.

```ts
import { SparseBatcher } from 'murow/core/sparse-batcher';

const grid = new SparseBatcher(4096);
// insert
grid.add(cellX, cellZ, entity);
// ...consume the bucket for one cell, then clear at the end of the frame
```

### Zero-alloc math and rays

Math helpers are offset-based (write into `Float32Array`s); `Ray2D`/`Ray3D` are settable and return a scalar `t` (or `null`) from `intersects*` — no per-call `Vec` objects. Use these in hot loops instead of allocating.

```ts
import { Ray3D } from 'murow/core/ray';
const ray = new Ray3D();
ray.set(ox, oy, oz, dx, dy, dz);
const t = ray.intersectsPlane(nx, ny, nz, d);   // number | null, no allocation
```

### Custom pools — `FreeList` and `PooledCollection`

Reach for the bare `FreeList` only when you own the data and generations. Reach for `PooledCollection` when you're building a registry of **versioned handles** where a stale id must fail to look up.

```ts
import { PooledCollection } from 'murow/core/collection';

class Effects extends PooledCollection<EffectId, EffectHandle, number> {
  add(opts): EffectHandle | null {
    const a = this.allocateItem(); if (!a) return null;
    // ...write this effect's arrays at `a.slot`...
    return a.item;
  }
  protected createItem(id: EffectId, slot: number): EffectHandle { /* ... */ }
  protected destroySlot(slot: number): void { /* ... */ }
}
```

Every renderer manager (`renderer.instances`, `renderer.sprites`, `renderer.materials`, `renderer.decals`) is a `PooledCollection`; the handles you get back are versioned.

## Structural-change discipline

Do not spawn/despawn-like mutate membership while iterating a `world.query(...)`. `world.despawn` is recorded and applied at a sync point (`world.flushDespawned()`); queue **spawns and component adds** the same way and apply them after the iteration:

```ts
const pendingSpawns: { kind: number; x: number; z: number }[] = [];

function spawnSystem(world: World) {
  for (const e of world.query(DeathTag)) { /* ... */ }
  // apply queued spawns AFTER iterating
  for (const s of pendingSpawns) spawnEntity(world, s.x, s.z);
  pendingSpawns.length = 0;
}
```

Read `world.getDespawned()` (reused `Uint32Array`) in the same tick you consume it; call `world.flushDespawned()` when done.

## Gotchas

- **`world.get` returns a reused object** — invalidated by the next `get`. Copy out, or use `world.fields(C)`.
- **`world.query` returns a reused array** — don't retain it across another query.
- **Store slot ids as `u32`** in components and sentinel them (`0xffffffff`), never as objects.
- **Brand id spaces.** `SlotId<'path'>` vs `SlotId<'entity'>` prevents cross-wiring a path slot into an entity slot.
- **Don't `Map` in hot loops.** `SlotStore`, `SlotSet`, `SlotMap`, `SparseBatcher` exist to replace per-frame `Map<id, handle>`.
- **`findPath` returns a fresh `Vec2[]` and its cache returns the same array** — copy into your row, never mutate the returned array.
- **Determinism (netcode):** predictions are allocation-free *and* deterministic — `ctx.fields`, `ctx.rng`, `ctx.deltaTime`; no `Date.now`/`Math.random`/module state.
- **Don't `setTimeout`/`setInterval`.** They allocate a closure per timer, run off the tick, and break determinism. Use the loop's pooled, tick-bound schedules: `loop.every(n).seconds(cb)` / `loop.in(n).ticks(cb)` (see the [determinism guide](./determinism.md#scheduling--never-settimeout--setinterval--requestanimationframe)).

## Game thing → container quick reference

| thing | container | key |
|---|---|---|
| hp/mana/level/team/heroId/speed | component | entity |
| mesh handle, DOM bar, rigid body, held sound, light | `SlotStore` | entity |
| nav path, agent row, projectile row | `SlotMap` (+ slot id field) | slot |
| AOI set, selection, spatial query results | `SlotSet` | entity |
| kill feed, chat, combat log, input history, lag-comp, snapshots | `Ring` / `RingStore` / `RingBuffer` | ring position |
| items grouped by two integer keys (cell, layer, team×lane) | `SparseBatcher` | two keys → slot |
| messages / component-set serialization | `PooledCodec` / `BinaryCodec` | — |
| hero/skill/item definitions | `Bucket` or a plain table (`HEROES[id]`) | id |
| your own handle/block pool | `FreeList` | slot |
| your own versioned-handle registry | `PooledCollection` | versioned id |
| dirtiness / despawns | `World` (`markDirty` / `getDespawned`) | entity |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



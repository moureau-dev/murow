# Entities and components (ECS) in murow

murow's ECS is data-oriented: a component is a **typed binary schema** stored as Structure-of-Arrays (one typed array per field, per component), and an entity is just a `number` slot. This guide is the practical companion to the API: how to define components, create a world, spawn and query entities, pick a system pattern, and stay inside the hot-path contracts. It is not an API dump; the exhaustive surface lives in the ECS sections of llms.txt and `packages/murow/src/ecs/README.md`.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **A component is a descriptor, not a class.** Define it once with `defineComponent(name, { schema })` and pass it back to every World call. There is no `Position` instance.
2. **Entities are plain `number`s** (slots, recycled on despawn). `world.spawn()` returns one; `world.despawn(e)` frees it.
3. **One component of each type per entity.** Membership is a single bit in a per-entity bitmask, so you can never hold two `Skill`s on one entity. Model multiplicity with separate entities linked by a numeric field (e.g. `Skill { owner, slot }`).
4. **Fields must be scalar.** `f32`, `u8`, `u16`, `u32`, `i32` (and the other primitive widths) are allowed; struct/array fields throw at `defineComponent`. Split a vector into `x`/`y`/`z` fields.
5. **Read with `world.fields(C)`, write to hot loops.** Fields bundles are resolved once and are type-exact; they bypass dirty tracking, so mark networked components yourself.
6. **`world.get(e, C)` returns a reused object.** Read and copy out; never retain it. `world.query(...)` returns a reused array, valid only until the next structural change.
7. **Do not mutate a query while iterating it.** Queue spawns/adds and apply them after the loop; despawns are deferred and drained via `getDespawned()` / `flushDespawned()`.
8. **Use marker/tag components for cheap subset queries** (`MeshTag`, `HudTag`) instead of branching on a field inside the loop.
9. **Systems belong in `tick`; drawing belongs in `render`.** The `GameLoop` owns ticks; see the [determinism guide](./determinism.md).
10. **Use `ctx.fields(C)` in netcode**, not `world.fields`, so writes auto-mark dirty. See the [netcode guide](./netcode.md).

## Defining components

A component is a named binary schema. The World allocates one typed array per field per component, sized to `maxEntities` (SoA), so iteration over a single field is cache-friendly and allocation-free.

```ts
import { defineComponent, f32, u8, u16, u32, i32 } from 'murow';

export const Position = defineComponent('Position', { x: f32, y: f32 });
export const Velocity = defineComponent('Velocity', { vx: f32, vy: f32 });
export const Health   = defineComponent('Health',   { current: u16, max: u16 });
export const Team     = defineComponent('Team',     { id: u8 });
export const Order    = defineComponent('Order',    { path: u32, cursor: u16 }); // a slot id, not an object
export const Turn     = defineComponent('Turn',     { facing: i32 });            // signed
// marker components make subset queries cheap
export const MeshTag  = defineComponent('MeshTag',  { _pad: u8 });
export const HudTag   = defineComponent('HudTag',   { _pad: u8 });
```

Field types map to the underlying array kind: `f32` → `Float32Array`, `i32` → `Int32Array`, `u32` → `Uint32Array`, `u16` → `Uint16Array`, `u8` → `Uint8Array`. The schema is also the serialization layout, so the same definition is used for snapshots.

**Struct and array fields are not supported.** A field's value must be scalar; composite fields throw inside `defineComponent`. Model a vector as separate fields (`x`, `y`, `z`).

### Networked components

Networked components use the **descriptor form** — pass `{ schema, sync }` instead of a bare schema. `networked()` (from `murow/netcode`) is an identity helper that gives the `sync` block full type checking; core never interprets it, but the World records the component as synced so it can participate in dirty tracking and snapshots.

```ts
import { defineComponent, f32 } from 'murow';
import { networked } from 'murow/netcode';

export const NetPosition = defineComponent('NetPosition', {
  schema: { x: f32, y: f32 },
  sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});
```

`rate` (`'every-tick' | 'on-change' | { every: N }`), `interest` (`'global'` or a plugin name), `interp` (`'lerp' | 'slerp' | 'step' | 'none'`), and an optional `snapThreshold` are validated at compile time. The [netcode guide](./netcode.md) covers the sync model in depth.

## Creating a world

```ts
import { World } from 'murow';

const world = new World({
  maxEntities: 10_000,               // optional; defaults to 10_000
  components: [Position, Velocity, Health, Team, Order, MeshTag, HudTag],
});
```

Every component must be registered up front. `world.addComponent(C)` registers one after construction if you need it, and is idempotent.

## Entities and the World API

Entities are numeric ids allocated from a ring buffer free list, so despawned slots are recycled by a later `spawn()`. The core operations:

```ts
const e = world.spawn();
world.isAlive(e);

world.add(e, Position, { x: 0, y: 0 });   // throws if the entity is not alive
world.has(e, Position);                    // boolean
world.get(e, Position);                    // reused Readonly<Position> — read, don't retain
world.set(e, Position, { x: 0, y: 0 });    // full overwrite
world.update(e, Position, { x: 100 });     // partial update — only listed fields change
world.remove(e, Position);

world.despawn(e);
```

Other World members you will reach for:

- `world.entity(e)` — an `EntityHandle` (fluent API, below).
- `world.query(...Cs)` — entities holding all listed components (see below).
- `world.fields(C)` — typed-array bundle per field (see below).
- `world.getFieldArray(C, 'x')` — a single raw typed array.
- `world.getEntities()` — a reused `Uint32Array` of alive ids.
- `world.getEntityCount()`, `world.getMaxEntities()`, `world.getComponents()`.
- `world.markDirty(e, index)`, `world.isDirty(e, C)`, `world.clearDirty(e, C)`, `world.forEachDirty(C, cb)`, `world.clearAllDirty()`.
- `world.serialize(e)` / `world.restore(e, bytes)` and the hot-path `writeEntity` / `readEntity` against a caller-owned `DataView`.

`world.get` throws if the entity does not hold the component; check `world.has` first when the relation is optional. Adding a component to a dead entity throws too.

### The fluent `EntityHandle` API

`world.entity(e)` wraps an entity in a chainable handle. It is optimised for repeated operations on one entity (component indices are cached on first access) and is the ergonomic entry point for setup code.

```ts
const player = world.entity(world.spawn())
  .add(Position, { x: 0, y: 0 })
  .add(Velocity, { vx: 10, vy: 0 })
  .add(Health, { current: 100, max: 100 });

player.get(Position);                      // reused read-only view
player.getMutable(Position);               // fresh mutable copy — write back with set/update
player.getField(Position, 'x');            // number
player.field(Position, 'x');               // raw TypedArray reference
player.has(Position);
player.update(Position, { x: 100 });       // partial
player.setFields(Position, (p) => { p.x += 10; }); // mutate in place
player.set(Position, { x: 0, y: 0 });      // full overwrite
player.setField(Position, 'x', 150);       // single field, no object
player.remove(Velocity);
player.despawn();
player.isAlive();
player.id;                                 // the raw entity number
```

Batch many writes to one entity into a single flush:

```ts
player
  .beginUpdate()
  .prepare(Position, Velocity)             // optional: pre-fetch component data
  .update(Position, { x: 5 })
  .setField(Velocity, 'vx', 1)
  .flush();
```

## Queries and the hot-path contracts

```ts
const q = world.query(Position, Velocity);
for (let i = 0; i < q.length; i++) {
  const eid = q[i];
  // ...
}
```

- **`world.query(...)` returns a reused `readonly Entity[]`.** The cache is maintained incrementally on every structural change (`spawn` / `despawn` / `add` / `remove`); it is not an iterator and not a fresh array. Do not retain a query result across a structural change — re-query, or defer the edits.
- **`world.get(e, C)` returns a reused object** (`ComponentStore` keeps a single object per component). The next `get` overwrites it.
- **`world.fields(C)` returns the same frozen bundle every call**, built once at registration.

Queries cost `O(alive)` only the first time a mask is seen; a single-component query aliases that component's member list directly, and multi-component caches are kept current incrementally. See the [performance guide](./performance.md) and the [zero-allocation guide](./zero-allocation.md).

## `world.fields()` — typed bundles per component

For hand-written hot loops, `world.fields(C)` returns the typed arrays for every field of a component, with exact element types inferred from the schema:

```ts
const pos = world.fields(Position);   // { x: Float32Array, y: Float32Array }
const vel = world.fields(Velocity);   // { vx: Float32Array, vy: Float32Array }

for (const e of world.query(Position, Velocity)) {
  pos.x[e] += vel.vx[e] * deltaTime;
  pos.y[e] += vel.vy[e] * deltaTime;
}
```

Direct typed-array writes **bypass dirty tracking**. For networked components, either use `ctx.fields(C)` in netcode (which auto-marks the entity dirty), call `world.markDirty(e, C.__worldIndex)` after the write, or use `world.update(e, C, ...)`. Local-only components have no dirty tracking to worry about.

## Four API patterns for systems

Pick per system based on how hot the loop is and how much ergonomic polish you want.

| pattern | speed | when to use |
|---|---|---|
| RAW | fastest | critical hot paths; manual `getFieldArray` hoisting |
| **Fields** | ~1.3x slower | **recommended for hand-written systems**; `world.fields(C)` |
| Hybrid | ~2x slower | System Builder + raw array access; production-ready |
| Ergonomic | ~3x slower | System Builder + cached getters; prototyping |

There is also a **Direct** tier (`world.get` / `world.update`) at roughly 6x slower: use it for one-off work, test setup, or debug tooling, never in a per-frame loop.

**RAW** — direct array access, 0% overhead:

```ts
const xs  = world.getFieldArray(Position, 'x');
const vxs = world.getFieldArray(Velocity, 'vx');

const entities = world.query(Position, Velocity);
for (let i = 0; i < entities.length; i++) {
  const eid = entities[i]!;
  xs[eid]! += vxs[eid]! * deltaTime;
}
```

**Fields** — per-component typed bundles, the recommended hand-written pattern:

```ts
const pos = world.fields(Position);
const vel = world.fields(Velocity);

const entities = world.query(Position, Velocity);
for (let i = 0; i < entities.length; i++) {
  const eid = entities[i]!;
  pos.x[eid]! += vel.vx[eid]! * deltaTime;
  pos.y[eid]! += vel.vy[eid]! * deltaTime;
}
```

For netcode predictions/handlers, use `ctx.fields(C)` — the same speed plus automatic dirty tracking.

**Hybrid** — System Builder with explicit array access:

```ts
world
  .addSystem()
  .query(Position, Velocity)
  .fields([
    { position: ['x', 'y'] },
    { velocity: ['vx', 'vy'] },
  ])
  .run((entity, deltaTime) => {
    entity.position_x_array[entity.eid]! += entity.velocity_vx_array[entity.eid]! * deltaTime;
    entity.position_y_array[entity.eid]! += entity.velocity_vy_array[entity.eid]! * deltaTime;
  });

world.runSystems(deltaTime);
```

**Ergonomic** — cached getter/setter, same builder shape:

```ts
world
  .addSystem()
  .query(Position, Velocity)
  .fields([
    { position: ['x', 'y'] },
    { velocity: ['vx', 'vy'] },
  ])
  .run((entity, deltaTime) => {
    entity.position_x += entity.velocity_vx * deltaTime;
    entity.position_y += entity.velocity_vy * deltaTime;
  });

world.runSystems(deltaTime);
```

## System builder shape

`addSystem()` returns a fluent builder:

```ts
world
  .addSystem()
  .query(Component1, Component2, /* … */)
  .fields([
    { alias1: ['fieldA', 'fieldB'] },
    { alias2: ['fieldC'] },
  ])
  .when?((entity) => boolean)              // optional filter, called per entity
  .run((entity, deltaTime, world) => { /* … */ });
```

The `entity` argument passed to `.run` (and `.when`) is a proxy synthesised from the `.fields([...])` declaration. For each `{ alias: ['fieldA'] }` entry the proxy gains both `<alias>_<field>` (an Ergonomic getter/setter) and `<alias>_<field>_array` (the raw typed array). The proxy shape is fixed — it is built once per system and its `eid` is updated per entity, so `.run` allocates nothing per entity.

```ts
type SystemEntity = {
  eid: Entity;                                    // current entity id
  despawn(): void;                                // defer despawn until flushDespawned

  // for every (alias, field) declared in .fields([...]):
  [`${alias}_${field}`]: number;                  // Ergonomic getter/setter
  [`${alias}_${field}_array`]: Float32Array;      // Hybrid/RAW typed array; index with entity.eid
};
```

`.when((e) => …)` receives only the proxy. If a system's query includes any synced component, every entity it touches is marked dirty for those components after the callback runs.

## Conditional systems and cross-entity reads

```ts
// only run when the condition holds
world
  .addSystem()
  .query(Health)
  .fields([{ health: ['current', 'max'] }])
  .when((e) => e.health_current > 0 && e.health_current < e.health_max)
  .run((e, deltaTime) => { e.health_current += 5 * deltaTime; });

// read from another entity via a hoisted array
const armorValue = world.getFieldArray(Armor, 'value');
world
  .addSystem()
  .query(Damage, Target)
  .fields([
    { damage: ['amount'] },
    { target: ['entityId'] },
  ])
  .run((e, deltaTime, world) => {
    const targetId = e.target_entityId;
    if (!world.isAlive(targetId)) return;
    let dmg = e.damage_amount;
    if (world.has(targetId, Armor)) dmg -= armorValue[targetId]! * 0.1;
    // write to the other entity's store...
  });
```

Writing to a **different** entity from a prediction needs `ctx.markDirty(C, targetId)`; from a system, mark it on the World after the write. Cross-entity reads should stay on the fields bundles so they do not allocate.

## Despawn lifecycle

`despawn` is **deferred**: the entity is marked dead immediately, but its slot stays reserved until you flush, so a renderer or netcode layer can tear down its handles first.

```ts
const despawned = world.getDespawned();  // Uint32Array — only entities killed this tick
for (let i = 0; i < despawned.length; i++) {
  const eid = despawned[i];
  // tear down renderer handles, pooled rows, etc.
}
world.flushDespawned();                  // release the slots for reuse
```

`getDespawned()` returns a **reused `Uint32Array` subarray** (not a plain `Entity[]`) — read it in the same tick, do not retain it. Despawned ids are recycled from a ring buffer, so a slot freed this tick may be handed back by `world.spawn()` soon after. The cost is `O(deaths)`, not `O(maxEntities)`.

Do not spawn or add components while iterating a query. Queue those edits and apply them after the loop; despawns are queued for you and drained at the flush.

## Marker/tag components for cheap subsets

A tag is just a component with no meaningful fields (or a padding field). It lets a query select a subset by bitmask instead of scanning a field value inside the loop.

```ts
export const MeshTag = defineComponent('MeshTag', { _pad: u8 });
export const HudTag  = defineComponent('HudTag',  { _pad: u8 });

world.add(e, MeshTag, { _pad: 0 });

for (const e of world.query(MeshTag, Position)) {
  // only meshes, already filtered by the query mask
}
```

## One component of each type per entity

Membership is a single bit per entity per component index, so an entity either has a component or it does not — **you cannot hold two of the same component**. `world.add(e, C, ...)` on an entity that already has `C` overwrites its data rather than creating a second one.

To model multiplicity (multiple skills, buffs, attachments), use **separate entities linked by a numeric field**:

```ts
// one Skill per entity, several Skill entities point at a shared owner
export const Skill  = defineComponent('Skill',  { owner: u32, slot: u16, rank: u8 });

function grantSkill(world: World, owner: Entity, slot: number, rank: number) {
  const s = world.spawn();
  world.add(s, Skill, { owner, slot, rank });
}
```

Query the link target with an entity id field the same way you would any other numeric field, guarding with `world.isAlive`.

## Performance note

Storage is SoA (one typed array per field), and queries are bitmask membership checks — roughly `(mask0[e] & mask) === mask` per component word — evaluated against a maintained cache rather than rescanning all entities each call. The first evaluation of a mask scans from the smallest member list; afterwards the cache is updated incrementally on `add` / `remove`. This is why the fields bundles and query caches are worth the ergonomic trade-off. See the [performance guide](./performance.md) for the ECS/SoA model and the frame-budget context.

## Gotchas

- **`world.get` returns a reused object** — invalidated by the next `get`. Copy out (spread / `getMutable`) or read via `world.fields`.
- **`world.query` returns a reused array** — don't hold it across a structural change. Re-query or defer edits.
- **`getDespawned()` is a reused `Uint32Array`** — consume it in the same tick, then `flushDespawned()`.
- **Adding the same component type twice overwrites.** One component per type per entity, because membership is a bitmask bit.
- **Struct/array fields throw at `defineComponent`.** Flatten vectors into scalar fields.
- **`world.fields` and `getFieldArray` bypass dirty tracking.** For networked components call `world.markDirty(e, C.__worldIndex)` (or use `ctx.fields` in netcode) after writing.
- **`world.get` / `world.update` throw** when the entity is dead or lacks the component. Guard with `world.has` / `world.isAlive` for optional relations.
- **Use tags for subsets.** Branching on a field inside a hot loop is slower than a query mask.
- **Recycled ids.** After `flushDespawned`, a despawned id can be reused; don't hold an entity id past the despawn flush if the slot may be reassigned.
- **Netcode writes use `ctx.fields`.** `ctx.fields(C)` auto-marks dirty; `ctx.world.fields(C)` does not, so call `ctx.markDirty(C, e)` yourself (including cross-entity writes).

## Quick reference

| want | use |
|---|---|
| define a component | `defineComponent(name, { schema })` |
| define a networked component | `defineComponent(name, { schema, sync: networked({...}) })` (from `murow/netcode`) |
| create a world | `new World({ maxEntities, components })` |
| spawn / despawn | `world.spawn()` / `world.despawn(e)` |
| add / get / set / update | `world.add` · `world.get` · `world.set` · `world.update` |
| membership / removal | `world.has(e, C)` / `world.remove(e, C)` |
| iterate a subset | `world.query(C1, C2)` (reused array) |
| typed field arrays | `world.fields(C)` (or `world.getFieldArray(C, 'x')`) |
| fluent per-entity ops | `world.entity(e).add(...).update(...)` |
| batch one entity's writes | `handle.beginUpdate().update(...).flush()` |
| mark a networked write dirty | `world.markDirty(e, C.__worldIndex)` (or `ctx.markDirty`) |
| despawn teardown | `world.getDespawned()` then `world.flushDespawned()` |
| cheap subset query | a marker/tag component (`MeshTag`, `HudTag`) |
| multiple of a "thing" | separate entities linked by a numeric field (`Skill { owner, slot }`) |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [Testing](./testing.md)


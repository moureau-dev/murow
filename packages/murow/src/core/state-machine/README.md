# StateMachine

A fixed-capacity, zero-GC finite state machine over many entities. One machine
definition drives every entity; per-entity state and data live in binary columns
indexed by a stable slot, so iteration is dense and transitions allocate nothing.

It composes the existing core primitives ([`SlotStore`](../slot-map),
[`EventSystem`](../events), [`SimpleRNG`](../simple-rng), and
[`BinaryCodec`](../binary-codec) field schemas) and depends on nothing else — no
loop, ECS, renderer, or netcode. It speaks entity ids and bytes.

## Usage

Declare the states and each one's data schema in the constructor, then register
behavior with `add`. `add` is cumulative and chainable.

```typescript
import { StateMachine } from "murow";
import { u8, u32 } from "murow/core";

const ai = new StateMachine({
  initial: "patrol",
  capacity: 1024,
  states: {
    patrol: { waypoint: u8 },
    chase:  { targetId: u32 },
    flee:   { until: u32 },
  },
})
  .add("patrol", {
    update: (e) => {
      const npc = world.npc(e.id);          // your closure reads whatever it needs
      if (npc.sees) { e.targetId = npc.target; e.change("chase"); }
      else patrol(npc, e.waypoint);
    },
  })
  .add("chase", {
    enter:  (e, targetId) => { e.targetId = targetId; },
    update: (e) => { if (world.npc(e.id).hp < 20) e.change("flee", world.tick + 60); },
  })
  .add("flee", { update: (e) => { if (e.ticksInState > 60) e.change("patrol"); } });
```

Drive it from wherever owns the clock; react to transitions on `events`.

```typescript
ai.events.on("change", ({ id, to }) => { if (to === ai.id.chase) playAlert(id); });

onEnemySpawn((id) => { ai.spawn(id).waypoint = 0; });
onEnemyDeath((id) => ai.remove(id));

loop.events.on("tick", () => ai.tick());
```

## Model

- **States are numeric** (`ai.id.chase`); the string names are authoring keys.
  The current state is stored as a `u8` column, so up to 256 states.
- **Per-state data is a binary schema** declared in `states`. Fields map to
  columns; the handle exposes them as typed properties. Scalars are zero-GC;
  vector/color fields allocate on read, so prefer scalars on the hot path.
- **Behavior is shared, cumulative handlers** registered with `add`, not
  per-entity objects. `enter`/`exit` run on transition; `update` runs each tick.
- **`update` is first-transition-wins**: handlers run in registration order and
  the first to `change` ends that entity's chain for the tick. `enter`/`exit`
  always run to completion.
- **Reads live in your handlers.** There is no `read` step — `update` is your
  closure and may read anything (a component, a sensor, a plain object). The
  machine references none of it, which is what keeps it ECS-independent.

## Handle

`spawn`/`of` return a `Handle` — a reused cursor for one entity, allocated once
at `spawn` and dropped at `remove`.

- `handle.id` — the entity id you spawned with.
- `handle.state` / `handle.stateId` — current state name / numeric id.
- `handle.ticksInState` — ticks since the last transition.
- `handle.is(name)` — state check.
- `handle.change(to, payload?)` — transition, with an optional numeric payload
  passed to the target's `enter`. For richer payloads, set fields then `change`.
- typed field accessors from the schema (`handle.waypoint`, `handle.targetId`).

## API

- `new StateMachine({ initial, states, capacity?, maxId?, rng? })` — `maxId`
  sizes the id lookup when entity ids come from a larger space than `capacity`;
  `rng` is injected for deterministic guards (defaults to a fixed seed).
- `add(state, { enter?, update?, exit? }): this` — register cumulative behavior.
- `spawn(id): Handle` / `of(id): Handle | null` / `has(id)` / `remove(id)` —
  lifecycle. `remove` during `tick` is deferred and compacted after the pass.
- `tick(): void` — advance every entity one step.
- `serialize(id, dv, offset): number` / `restore(id, dv, offset): number` /
  `byteSize(id): number` — binary read/write of an entity's state id and current
  fields, for snapshotting. Returns the offset past the bytes touched.
- `events.on("change", ({ id, from, to }) => ...)` — transition channel.
- `id` — state name to numeric id map. `size` — live entity count.

## When to use it

For server-authoritative AI behavior, lifecycle, and presentation/animation
state — anything ticked locally where state and data should stay in dense
columns. The binary `serialize`/`restore` let a transport snapshot an entity's
machine state without the machine knowing the transport exists.

It is not a replacement for client-side prediction: predicted gameplay state
belongs in the data the reconciler restores (see [`prediction`](../prediction)),
not in a standalone machine the reconciler cannot see.

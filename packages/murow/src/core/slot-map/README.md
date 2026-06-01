# SlotMap

A zero-GC, O(1) dense slot set for managing runtime-allocated things you both **iterate every frame** and **look up by id**. It is the `FreeList` + packed-array + sparse-reverse-index pattern (dense iteration, swap-and-pop removal, slot recycling) written once, tested once, and type-safe — instead of hand-rolled at every call site.

Two classes ship from this module:

- `SlotMap` — manages integer slots. The id **is** the slot. Use it when the thing you allocate has no companion object (GPU instance/light data rows, particle slots, entity-id tracking).
- `SlotStore<TId, T>` — layers a slot-indexed object array on top of `SlotMap`, keyed by an external id that need not equal the slot. The typed replacement for `Map<id, handle>` collections iterated every frame.

## Features

- O(1) `add`, `remove`, and `has` with no garbage collection pressure.
- Dense packed iteration — `activeSlots` over `[0, size)`, zero per-call allocation.
- Sparse `Int32Array` reverse index (`-1` sentinel) instead of a `Map` for id lookup.
- Swap-and-pop removal that keeps the dense array packed and fixes the reverse index — the bug-prone bookkeeping lives in one tested place.
- Stable slots: the slot returned by `add` does not move while live, so it is safe to store as a GPU buffer index or inside a handle.
- Built on `FreeList`; composes the existing primitive rather than reimplementing allocation.
- Zero runtime dependencies beyond `FreeList`.

## id vs slot

The distinction is the whole design, so it is worth stating once:

- **slot** — the stable index into your data/GPU buffers. Allocated by the internal `FreeList`, stable for the slot's lifetime.
- **id** — the external key you look things up by.

In `SlotMap` these are the **same number**: the slot you allocate is the id. `remove(slot)` is therefore already "remove by id" — there is no separate `removeById`.

In `SlotStore` they are **different spaces**: an external id (e.g. an ECS entity id) maps to a slot. `remove(id)` is the primary entry point because callers (netcode despawn, gameplay) hold the id, not the slot.

## Usage

### SlotMap — id is the slot

```typescript
import { SlotMap } from './slot-map';

const slots = new SlotMap(1024);
const data = new Float32Array(1024 * 4); // 4 floats per slot

const slot = slots.add();          // allocate; slot is stable
data[slot * 4] = 1.0;

// Iterate live slots every frame, zero allocation:
const active = slots.activeSlots;
for (let i = 0; i < slots.size; i++) {
  const s = active[i];
  data[s * 4] += 0.1;
}

slots.remove(slot);                // swap-and-pop, frees the slot
slots.has(slot);                   // false
```

### SlotStore — external id keys an object

```typescript
import { SlotStore } from './slot-map';

type EntityId = number;
// up to 256 minions live at once, keyed by entity ids from a 10k-entity world
const minions = new SlotStore<EntityId, InstanceHandle>(256, 10_000);

minions.add(entityId, handle);     // store under an external id
minions.get(entityId);             // O(1) lookup -> handle | null
minions.has(entityId);             // O(1)

// Dense per-tick iteration over the handles:
minions.forEach((handle, id, slot) => {
  handle.setPosition(/* ... */);
});

minions.remove(entityId);          // O(1), keeps iteration packed
```

## API

### `SlotMap`

- `add(): number` — Allocate a slot and add it to the live set. Returns the slot, or `-1` if exhausted.
- `remove(slot: number): void` — Remove a slot and return it to the pool (O(1) swap-and-pop). No-op if not live.
- `has(slot: number): boolean` — Whether the slot is currently live.
- `activeSlots: Uint32Array` — Packed live slots, valid for `[0, size)`. Reused — do not retain.
- `size: number` — Number of live slots.
- `capacity: number` — Configured max.
- `hasAvailable(): boolean` — Whether another slot can be allocated.
- `forEach(fn: (slot, index) => void): void` — Iterate live slots, zero allocation.
- `clear(): void` — Return every slot to the pool.

### `SlotStore<TId extends number, T>`

- `new SlotStore(capacity, maxId = capacity)` — `capacity` caps how many items are live at once; `maxId` sizes the id lookup table (pass it when ids come from a larger space than the store holds, e.g. an archetype store keyed by entity ids).
- `add(id: TId, item: T): number` — Store `item` under `id`; returns the slot. Throws if `id` is out of range, already present, or capacity is reached.
- `remove(id: TId): void` — Remove the item under `id`. No-op if absent.
- `get(id: TId): T | null` — The item under `id`, or `null`.
- `has(id: TId): boolean` — Whether `id` is present.
- `slotOf(id: TId): number` — The stable slot for `id`, or `-1`.
- `size: number` / `capacity: number` / `hasAvailable(): boolean`
- `forEach(fn: (item, id, slot) => void): void` — Dense iteration over stored items.
- `clear(): void` — Remove every item.

## When to use it

Reach for this when a collection has all three of: runtime add/remove, a stable slot something holds onto, and dense per-frame iteration or id lookup. That covers instanced renderer data, lights, blob shadows, and per-archetype handle collections.

It is **not** the right tool for append-only name registries (`Map<string, number>` is correct there), for anonymous fungible pools with no id and no stable slot (a plain count is enough), or for string-keyed lookups touched only on connect/disconnect (keep the `Map` at that boundary). `SlotStore` ids must be non-negative integers below `maxId`.

## Ids

Both `SlotMap` and `SlotStore` index typed arrays by id, so ids must be small non-negative integers. The exported `SlotId<Brand>` type is a compile-time brand for keeping distinct id spaces from being cross-wired:

```typescript
import type { SlotId } from './slot-map';

type LightId = SlotId<'light'>;
type EntityId = SlotId<'entity'>;
// a LightId can no longer be passed where an EntityId is expected
```

---

`SlotMap` centralizes the dense-slot pattern the engine previously hand-rolled per renderer — one allocation-free, tested implementation behind a typed API.

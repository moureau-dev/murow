# Collection

Generic, pooled, versioned item storage. The shared machinery behind every
renderer manager (`renderer.instances`, `renderer.sprites`, ...). Pure CPU, no
GPU, no backend types: the collection only knows that a stored item has a
numeric `id` and can `destroy` itself.

```ts
import {
  Collection,
  CollectionItem,
  PooledCollection,
  GenerationAllocator,
} from 'murow/core/collection';
```

## Contract

```ts
interface CollectionItem<Id extends number> {
  readonly id: Id;
  destroy(): void;
}

interface Collection<Id extends number, Item extends CollectionItem<Id>, Capacity = number> {
  readonly capacity: Capacity;
  readonly count: number;
  get(id: Id): Item | undefined;
  has(id: Id): boolean;
  remove(id: Id): void;
  each(cb: (item: Item) => void): void;   // dense slot order, zero allocation
  clear(): void;
  destroy(): void;
  readonly events: CollectionEvents<Item>; // 'add' | 'remove' | 'clear'
}
```

`CollectionItem` is the whole requirement: `id` + `destroy`. Renderer handles
add more on top (an `alive` flag, typed setters) but the collection never needs
it.

## `PooledCollection`

An abstract base implementing `Collection` over a dense slot space. Subclasses
own their domain storage in parallel arrays indexed by slot, name their own
creation method (`add` / `create`), and implement two hooks:

```ts
class Sprites extends PooledCollection<SpriteId, SpriteHandle, number> {
  add(opts): SpriteHandle | null {
    const allocated = this.allocateItem();       // slot + id + item, or null at capacity
    if (!allocated) return null;
    // ...write this sprite's domain data at allocated.slot...
    return allocated.item;
  }
  protected createItem(id: SpriteId, slot: number): SpriteHandle { /* build the handle */ }
  protected destroySlot(slot: number): void { /* free this slot's domain data */ }
}
```

- `allocateItem()` allocates a slot, calls `createItem`, stores it, and emits
  `add`. Returns `null` (after logging via the collection's `Logger`) when the
  pool is full.
- `remove(id)` frees one item and emits `remove`; stale ids are a no-op.
- `clear()` frees every item but keeps the collection usable; `destroy()`
  releases the collection's own resources (subclasses override and call
  `super.destroy()`).

## `GenerationAllocator`

The id/slot allocator underneath. A dense `SlotMap` plus a per-slot generation:
`id = generation * capacity + slot`. Freeing a slot bumps its generation, so a
stored id for a destroyed item fails `isLive` instead of aliasing a recycled
slot. Decoded with arithmetic (not 32-bit bitwise) so it stays exact.

## Notes

- **Ids are versioned.** `get(staleId)` returns `undefined`; it never returns a
  different item that reused the slot.
- **Numbers are the identity.** Brand them per backend (`SlotId<Brand>` from
  `murow/core/slot-map`) so ids cannot cross collections; a plain `number` is
  not assignable.
- **Pooled reuse, not an OS free.** `destroy()` returns a slot to the pool;
  memory is not returned to the OS.
- Backends define their own handle type. `@murow/webgpu` adds `HandleBase`
  (`CollectionItem` + an `alive` flag) and the concrete `MeshInstanceHandle`,
  `SpriteHandle`, etc.

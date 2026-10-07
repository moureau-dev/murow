# Ring

Fixed-capacity, zero-GC rings with **oldest-eviction**. Pushing past capacity
silently recycles the oldest entry, which is the right policy for transient,
cosmetic, or bounded-history data where stale entries should fall off the back.

This is the third reuse policy in core, and it is deliberately a separate type
from the others rather than a constructor flag:

- `FreeList` — reuse **freed** slots (LIFO). Allocation can fail.
- `SlotMap` / `SlotSet` / `SlotStore` — sparse membership with dense iteration
  and stable ids until `remove`.
- `Ring` (here) — never frees; always overwrites the oldest. No failure, no
  membership bookkeeping, insertion order is the whole state.

## Classes

- `Ring` — a ring of `u32` values. Use for id/flag histories (voice stealing,
  "recently seen" sets).
- `RingStore<T>` — a ring of objects. Objects are created once by a factory and
  reused in place, so `push()` never allocates. Use for transient record pools
  (decals, trails, floating combat text).
- `RingBuffer` — a ring of fixed-stride byte records over a reused `Uint8Array`.
  Use for binary history (lag-compensation frames, input/state history).

## Usage

```ts
import { Ring, RingStore, RingBuffer } from 'murow/core/ring';

// u32 ring: keep the last 8 source ids
const voices = new Ring(8);
voices.push(42);
voices.oldest();

// object ring: a pool of decals; the oldest is recycled automatically
const decals = new RingStore({ capacity: 256, create: () => ({ x: 0, y: 0, z: 0, cell: 0, spawn: 0 }) });
const slot = decals.push();
const d = decals.get(slot);   // mutate in place — no allocation
d.x = 3; d.spawn = tick;

// byte ring: fixed-size frames
const frames = new RingBuffer({ capacity: 64, stride: 256 });
const off = frames.offsetOf(frames.push());
new DataView(frames.bytes.buffer).setUint32(off, tick, true);
```

## Iteration

Every ring iterates **oldest to newest** via `forEach`, and exposes
`at(i)` / `slotAt(i)` (0 = oldest), `oldest()`, `newest()`, `size`, `capacity`,
`isFull`, and `clear()`. `RingBuffer` works in byte offsets (`offsetOf`,
`offsetAt`).

## Notes

- All three are fixed capacity; there is no growth. Size them from the renderer
  or system budget.
- Slot objects are reused, never replaced: keep a reference if you like, it
  stays valid (its *contents* get recycled).
- This is CPU-side. GPU ring pools (e.g. particles) live in the renderer and do
  not use these.

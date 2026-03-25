# SparseBatcher

A zero-GC draw-call batcher that organizes instance slots into `[layer][spritesheet]` buckets for efficient batched rendering. Only allocates buckets that are actually used — most games need fewer than 10.

## Features

- O(1) add and swap-and-pop removal within buckets.
- Iteration in layer order (back-to-front) via insertion sort on the tiny active bucket list.
- Zero allocations during iteration — reuses a pre-allocated sort buffer.
- Automatic bucket growth when a bucket exceeds its initial capacity.
- Renderer-agnostic — works with any backend (WebGPU, PixiJS, Three.js, etc.).

## Usage

```typescript
import { SparseBatcher } from './sparse-batcher';

const batcher = new SparseBatcher(10000);

// Register sprites into (layer, sheetId) buckets
batcher.add(0, 0, slotA);
batcher.add(0, 1, slotB);
batcher.add(1, 0, slotC);

// Iterate buckets in layer order for draw calls
batcher.each((sheetId, instances, count) => {
  bindTexture(sheetId);
  drawInstanced(instances, count);
});

// Remove a sprite (swap-and-pop within its bucket)
batcher.remove(0, 0, slotA);

// Clear everything
batcher.clear();
```

## API

- `add(layer, sheetId, slot)` — Register a slot in the given bucket.
- `remove(layer, sheetId, slot)` — Remove a slot from its bucket (O(1) swap-and-pop).
- `each(cb)` — Iterate active buckets in ascending layer order. Callback receives `(sheetId, instances: Uint32Array, count)`.
- `getActiveCount()` — Number of non-empty buckets.
- `getTotalCount()` — Total slots across all buckets.
- `clear()` — Reset all buckets.

## Memory

With 10k sprites across 3 layers × 4 spritesheets (12 buckets):

| Data          | Size     |
|---------------|----------|
| Buckets       | ~480 KB  |
| Bucket sizes  | 16 KB    |
| Active list   | 8 KB     |
| **Total**     | **~504 KB** |

---

`SparseBatcher` provides efficient, allocation-free draw-call batching for any instanced renderer.

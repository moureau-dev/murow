# FreeList

A zero-GC, O(1) index allocator for managing reusable slots in fixed-size pools. Ideal for entity allocation in ECS systems, object pools, and any scenario where you need fast, allocation-free index management.

## Features

- O(1) allocation and deallocation with no garbage collection pressure.
- Uses a compact `Uint32Array` internally for cache-friendly access.
- Double-free detection with a descriptive error.
- Tracks available and allocated slot counts.
- Zero dependencies.

## Usage

```typescript
import { FreeList } from './free-list';

// Create a pool with 1024 slots
const pool = new FreeList(1024);

// Allocate an index
const idx = pool.allocate(); // 1023, 1022, ...

// Use the index for your data
entities[idx] = createEntity();

// Free the index when done
pool.free(idx);

// Check availability
pool.hasAvailable();      // true if slots remain
pool.getAvailableCount(); // number of free slots
pool.getAllocatedCount();  // number of used slots
```

## API

- `allocate(): number` — Returns an available index, or `-1` if the pool is exhausted.
- `free(index: number): void` — Returns an index to the pool. Throws if the pool is already full (double-free).
- `hasAvailable(): boolean` — Whether any slots are available.
- `getAvailableCount(): number` — Number of free slots.
- `getAllocatedCount(): number` — Number of allocated slots.

## Example: Entity Pool

```typescript
const MAX_ENTITIES = 4096;
const pool = new FreeList(MAX_ENTITIES);
const positions = new Float32Array(MAX_ENTITIES * 2);

function spawnEntity(x: number, y: number): number {
  const id = pool.allocate();
  if (id === -1) return -1; // pool exhausted

  positions[id * 2] = x;
  positions[id * 2 + 1] = y;
  return id;
}

function destroyEntity(id: number): void {
  positions[id * 2] = 0;
  positions[id * 2 + 1] = 0;
  pool.free(id);
}
```

---

`FreeList` provides a minimal, GC-free foundation for managing reusable indices in performance-critical game systems.

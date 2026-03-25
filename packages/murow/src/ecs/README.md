# Entity Component System (ECS)

A high-performance Entity Component System for multiplayer games, built on typed arrays with automatic pooling.

## Features

- **SoA Storage**: Components stored using Structure of Arrays (SoA) — one TypedArray per field — for cache-friendly field iteration and SIMD-friendly access
- **Zero Allocations**: Reusable DataView and ObjectPool eliminate GC pressure
- **BinaryCodec Integration**: Components use your existing schema definitions
- **PooledCodec Serialization**: Efficient network encoding built-in
- **Bitmask Queries**: Fast O(1) component checks and O(n) entity queries with query result caching
- **Unlimited Components**: Dynamically scales to support any number of components (32 per bitmask word)
- **Optimized Hot Paths**: Cached references and unrolled loops for <128 component common case
- **Simple API**: Define components, spawn entities, query and update

## Memory Layout: SoA (Structure of Arrays)

Murow ECS uses **SoA (Structure of Arrays)**, not AoS (Array of Structures).

Each component field is stored in its own dedicated TypedArray indexed by entity ID:

```
// AoS (NOT what murow does):
// [ { x, y, rotation }, { x, y, rotation }, ... ]

// SoA (what murow does):
// transformX:        Float32Array [ x0, x1, x2, ... ]
// transformY:        Float32Array [ y0, y1, y2, ... ]
// transformRotation: Float32Array [ r0, r1, r2, ... ]
```

**Tradeoffs vs AoS:**
- ✅ Faster single-field access across many entities (e.g. reading all `x` values)
- ✅ Better for vectorized / SIMD-style processing on individual fields
- ✅ Native TypedArray operations without byte-level arithmetic
- ❌ Whole-component reads require touching multiple arrays (more cache lines)
- ❌ Slightly more memory overhead per component (one TypedArray header per field)

Use `world.getFieldArray(Component, 'fieldName')` to get direct typed array access for the most performance-critical loops.

## Quick Start

```typescript
import { defineComponent, World, BinaryCodec } from 'murow';

// 1. Define components using BinaryCodec schemas
const Transform = defineComponent('Transform', {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
  rotation: BinaryCodec.f32,
});

const Velocity = defineComponent('Velocity', {
  vx: BinaryCodec.f32,
  vy: BinaryCodec.f32,
});

const Health = defineComponent('Health', {
  current: BinaryCodec.u16,
  max: BinaryCodec.u16,
});

// 2. Create a world with your components
const world = new World({
  maxEntities: 10000,
  components: [Transform, Velocity, Health],
});

// 3. Spawn entities and add components
const player = world.spawn();
world.add(player, Transform, { x: 100, y: 200, rotation: 0 });
world.add(player, Velocity, { vx: 10, vy: 20 });
world.add(player, Health, { current: 100, max: 100 });

// 4. Query and update entities
for (const entity of world.query(Transform, Velocity)) {
  const transform = world.get(entity, Transform);
  const velocity = world.get(entity, Velocity);

  // Update position using update() for efficiency
  world.update(entity, Transform, {
    x: transform.x + velocity.vx * deltaTime,
    y: transform.y + velocity.vy * deltaTime,
  });
}
```

## API Reference

### `defineComponent(name, schema)`

Define a component type with a binary schema.

```typescript
const Transform = defineComponent('Transform', {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
  rotation: BinaryCodec.f32,
});
```

**Parameters:**
- `name`: Unique name for the component
- `schema`: BinaryCodec schema defining the component's fields

**Returns:** Component definition that can be used with World

### `World`

Manages entities and their components.

#### Constructor

```typescript
const world = new World({
  maxEntities: 10000,  // Optional, defaults to 10000
  components: [Transform, Velocity, Health],
});
```

**Options:**
- `maxEntities`: Maximum number of entities (affects memory allocation)
- `components`: Array of component definitions (dynamically scales, 32 components per bitmask word)

#### Entity Management

```typescript
// Spawn a new entity
const entity = world.spawn();

// Despawn (destroy) an entity
world.despawn(entity);

// Check if entity is alive
world.isAlive(entity);
```

#### Component Operations

```typescript
// Add a component with initial data
world.add(entity, Transform, { x: 0, y: 0, rotation: 0 });

// Get component data (returns pooled object)
const transform = world.get(entity, Transform);

// Set component data (overwrites all fields)
world.set(entity, Transform, { x: 100, y: 200, rotation: 0 });

// Update partial fields (more efficient)
world.update(entity, Transform, { x: 150 });

// Check if entity has component
world.has(entity, Transform);

// Remove component from entity
world.remove(entity, Transform);
```

#### Querying

```typescript
// Query entities with specific components
for (const entity of world.query(Transform, Velocity)) {
  // Only entities with BOTH Transform AND Velocity
  const t = world.get(entity, Transform);
  const v = world.get(entity, Velocity);
  // ... process entity
}
```

#### Serialization

See [Networking](../net/README.md) for snapshot-based serialization using the same component schemas.

## Performance

**Highly optimized for multiplayer games** - zero allocations in hot paths, sub-millisecond queries with intelligent caching, scales to 50k+ entities.

### Quick Numbers

| Metric | Performance |
|--------|-------------|
| **Spawn rate** | 30M+ entities/sec |
| **Query speed (first)** | 10k entities in 0.13ms |
| **Query speed (cached)** | 10k entities in **0.01ms** (100x) |
| **Component access** | 9.3M ops/sec (get) |
| **Frame time** (5k entities) | 4.98ms avg (~200 FPS) |
| **Memory overhead** | Zero allocations in gameplay, <100KB for query cache |

### Realistic Game Simulation
11 systems with realistic workload (movement, rotation, boundaries, health regen, cooldowns, combat, death, status effects, lifetime, velocity damping, AI behavior).
Results averaged across 5 runs using **raw World API**:

| Entities | Avg Frame | Std Dev | Min | Max | FPS | 60fps (16.67ms) | 30fps (33.33ms) |
|----------|-----------|---------|-----|-----|-----|-----------------|-----------------|
| 500 | 0.57ms | ±0.05ms | 0.38ms | 2.27ms | 1,754 | ✅ 3.4% | ✅ 1.7% |
| 1,000 | 1.03ms | ±0.04ms | 0.78ms | 1.75ms | 972 | ✅ 6.2% | ✅ 3.1% |
| 5,000 | 4.98ms | ±0.36ms | 3.57ms | 11.12ms | 200 | ✅ 29.9% | ✅ 14.9% |
| 10,000 | 9.63ms | ±0.48ms | 8.19ms | 13.55ms | 103 | ✅ 57.8% | ✅ 28.9% |
| 25,000 | 22.91ms | ±1.02ms | 20.59ms | 28.65ms | 43 | ❌ 137.4% | ✅ 68.7% |
| 50,000 | 45.41ms | ±1.62ms | 38.14ms | 55.69ms | 22 | ❌ 272.4% | ❌ 136.2% |

**10k entities fits comfortably in 60 FPS budget. 25k entities achieves 30 FPS.**

Low standard deviations indicate stable, predictable performance across runs.

### Optimizations Applied
- **Query result caching** with archetype version tracking (16-473x speedup for repeated queries)
- **Object-based query buffers** and field lookups (2.2x faster than Map)
- Loop unrolling for 2/3/4-field components (covers 95% of use cases)
- Query loop unrolling (8x batch processing with write cursor)
- Single/dual-field update fast paths (zero allocation for common cases)
- Component-specialized read/write paths
- Inlined math operations in hot paths
- O(1) entity lookups with index mapping
- Power-of-2 ring buffer with bitwise operations

Run benchmarks: `bun test src/ecs/benchmark.test.ts`

**Methodology**: All performance numbers are averaged across 5 runs using `bun test --rerun-each=5` to account for JIT warmup and variance. The "Complex Game Simulation" benchmark uses the raw World API for maximum transparency.

## Advanced Usage

### Fluent API with EntityHandle

EntityHandle provides a chainable interface for entity operations with **zero runtime overhead**. Modern JIT compilers inline these simple method calls, making them identical in performance to the raw World API.

```typescript
// Fluent API - clean and expressive
const player = world.entity(world.spawn())
  .add(Transform, { x: 0, y: 0, rotation: 0 })
  .add(Health, { current: 100, max: 100 })
  .add(Velocity, { vx: 0, vy: 0 });

// Use the handle
player.update(Transform, { x: 10 });
const health = player.get(Health);

// Chain multiple operations
player
  .update(Health, { current: 50 })
  .update(Velocity, { vx: 5, vy: 5 });

// Access raw entity ID when needed
world.add(player.id, Armor, { value: 50 });

// Mix with raw API freely
for (const id of world.query(Transform, Velocity)) {
  const entity = world.entity(id);
  const t = entity.get(Transform);
  const v = entity.get(Velocity);
  entity.update(Transform, {
    x: t.x + v.vx * deltaTime,
    y: t.y + v.vy * deltaTime,
  });
}
```

**Performance**: EntityHandle has minimal overhead. Benchmark results show <5-15% overhead in complex simulations, well within acceptable range for the ergonomic benefits.

### Systems Pattern

```typescript
class MovementSystem {
  update(world: World, deltaTime: number) {
    for (const entity of world.query(Transform, Velocity)) {
      const t = world.get(entity, Transform);
      const v = world.get(entity, Velocity);

      // Use update() for efficient partial updates
      world.update(entity, Transform, {
        x: t.x + v.vx * deltaTime,
        y: t.y + v.vy * deltaTime,
      });
    }
  }
}

class HealthSystem {
  update(world: World) {
    for (const entity of world.query(Health)) {
      const health = world.get(entity, Health);

      if (health.current <= 0) {
        world.despawn(entity);
      }
    }
  }
}

// Game loop
const movementSystem = new MovementSystem();
const healthSystem = new HealthSystem();

function gameLoop(deltaTime: number) {
  movementSystem.update(world, deltaTime);
  healthSystem.update(world);
}
```

### Partial Updates

```typescript
// ❌ WRONG: Can't mutate readonly
const transform = world.get(entity, Transform);
transform.x = 150; // TypeScript error!
world.set(entity, Transform, transform);

// ✅ CORRECT: Use update() for partial changes (fastest!)
world.update(entity, Transform, { x: 150 });

// ✅ ALSO CORRECT: Use set() to replace all fields
world.set(entity, Transform, { x: 150, y: 200, rotation: 0 });
```

### Component Reuse with Tags

```typescript
// Create tag components (empty schemas)
const Enemy = defineComponent('Enemy', {
  _tag: BinaryCodec.u8, // Dummy field
});

const Player = defineComponent('Player', {
  _tag: BinaryCodec.u8,
});

// Add tags
world.add(entity, Enemy, { _tag: 1 });

// Query with tags
for (const entity of world.query(Transform, Enemy)) {
  // Only enemy entities with Transform
}
```

## Integration with Existing Code

The ECS integrates seamlessly with your existing networking code:

```typescript
// Define components (same schema for storage AND network!)
const Transform = defineComponent('Transform', {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
  rotation: BinaryCodec.f32,
});

// Use in ECS
world.add(entity, Transform, { x: 100, y: 200, rotation: 0 });

// Use in snapshots (same schema!)
snapshotRegistry.register('transform', Transform.arrayCodec);
```

## Best Practices

### 1. Keep Components Small
```typescript
// Good: Small, focused components
const Transform = defineComponent('Transform', { x: f32, y: f32, rotation: f32 });
const Velocity = defineComponent('Velocity', { vx: f32, vy: f32 });

// Bad: Large, monolithic component
const Entity = defineComponent('Entity', {
  x, y, rotation, vx, vy, health, maxHealth, damage, ...
});
```

### 2. Use Partial Updates
```typescript
// Good: Update only what changed
world.update(entity, Transform, { x: newX });

// Bad: Get + spread + set for single field
const t = world.get(entity, Transform);
world.set(entity, Transform, { ...t, x: newX });
```

### 3. Batch Operations
```typescript
// Good: Query once, process many
for (const entity of world.query(Transform, Velocity)) {
  // Process all entities in one loop
}

// Bad: Individual queries
for (const entity of world.getEntities()) {
  if (world.has(entity, Transform) && world.has(entity, Velocity)) {
    // Slower
  }
}
```

### 4. Avoid Nested Queries
```typescript
// Bad: O(n²) complexity
for (const e1 of world.query(Transform)) {
  for (const e2 of world.query(Transform)) {
    // Very slow!
  }
}

// Good: Use spatial partitioning for collision detection
const grid = new SpatialGrid();
// ... (see NavMesh or implement your own)
```

## Performance

Benchmark results (5-run average, 10,000 entities on Intel i5-2400 (4 cores) @ 3.4GHz, 2011):

**Complex Simulation (10+ systems):**
- 10.34ms average (98 FPS) ✅ Well under 60 FPS budget
- Handles realistic game workloads with ease

**25-Component Stress Test:**
- 18.90ms average (52 FPS) ✅ Passes 30 FPS target
- Extreme test with many components still performant

**Query Performance:**
- Single query: 0.209ms for 10,000 entities
- 100x repeated queries: 0.11ms (query result caching)
- Persistent cache invalidated only on archetype changes

**Key Optimizations:**
- Cached reference to first word (fast path for <32 components)
- Unrolled loops for 1-4 word cases (up to 128 components)
- Query mask caching (zero recomputation for repeated queries)
- Query result caching (invalidated only on spawn/despawn/add/remove)

**Scaling:**
- 500 entities: 0.6-0.7ms (1,500+ FPS)
- 1,000 entities: 1.1-1.3ms (800+ FPS)
- 5,000 entities: 5.0-5.5ms (180+ FPS)
- 10,000 entities: 10.3ms (98 FPS)
- 25,000 entities: 24ms (42 FPS)

All tests maintain excellent frame rates for realistic game scenarios. Modern CPUs will perform significantly better.

## Limitations

- **Fixed max entities** (set at world creation, affects memory allocation)
- **No component inheritance** (composition over inheritance pattern)
- **No component dependencies** (manage manually in systems)

## See Also

- [BinaryCodec](../core/binary-codec/README.md) - Schema definitions
- [PooledCodec](../core/pooled-codec/README.md) - Zero-copy serialization
- [Networking](../net/README.md) - Client/Server integration

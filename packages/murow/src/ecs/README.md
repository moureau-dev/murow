# Entity Component System (ECS)

High-performance ECS with **three API patterns** for different speed/ergonomics tradeoffs.

## Why Murow ECS?

- **Fast** — 10k entities in 1-3ms (RAW/Hybrid/Ergonomic modes)
- **Type-safe** — Full TypeScript inference, compile-time checks
- **Zero GC** — Reusable objects, cached queries, no allocations in hot paths
- **Flexible** — Choose your API: RAW (fastest), Hybrid (balanced), Ergonomic (cleanest)
- **Network-ready** — Same schema for storage and serialization

## Quick Start

```typescript
import { defineComponent, World, BinaryCodec } from 'murow';

// 1. Define components
const Transform = defineComponent('Transform', {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
  rotation: BinaryCodec.f32,
});

const Velocity = defineComponent('Velocity', {
  vx: BinaryCodec.f32,
  vy: BinaryCodec.f32,
});

// 2. Create world
const world = new World({
  maxEntities: 10000,
  components: [Transform, Velocity],
});

// 3. Spawn entities
const player = world.entity(world.spawn())
  .add(Transform, { x: 0, y: 0, rotation: 0 })
  .add(Velocity, { vx: 10, vy: 20 });

// 4. Query and update
for (const id of world.query(Transform, Velocity)) {
  const t = world.get(id, Transform);
  const v = world.get(id, Velocity);
  world.update(id, Transform, {
    x: t.x + v.vx * deltaTime,
    y: t.y + v.vy * deltaTime,
  });
}
```

## API Patterns

Murow ECS offers three patterns with different performance/ergonomics tradeoffs:

### 1. RAW API (Fastest)

Direct array access — **0% overhead**, maximum control.

<details>
<summary><strong>Example: Movement System</strong></summary>

```typescript
// Get direct typed arrays
const transformX = world.getFieldArray(Transform, 'x');
const transformY = world.getFieldArray(Transform, 'y');
const velocityVx = world.getFieldArray(Velocity, 'vx');
const velocityVy = world.getFieldArray(Velocity, 'vy');

// Manual loop with direct indexing
const entities = world.query(Transform, Velocity);
for (let i = 0; i < entities.length; i++) {
  const eid = entities[i]!;
  transformX[eid]! += velocityVx[eid]! * deltaTime;
  transformY[eid]! += velocityVy[eid]! * deltaTime;
}
```

**When to use:** Performance-critical hot paths, tight loops processing thousands of entities.

</details>

### 2. Hybrid API (Fast + Type-Safe)

System builder with direct array access — **~2× slower than RAW**, excellent balance.

<details>
<summary><strong>Example: Movement System</strong></summary>

```typescript
world
  .addSystem()
  .query(Transform, Velocity)
  .fields([
    { transform: ['x', 'y'] },
    { velocity: ['vx', 'vy'] }
  ])
  .run((entity, deltaTime) => {
    // Direct array access with entity ID
    entity.transform_x_array[entity.eid]! += entity.velocity_vx_array[entity.eid]! * deltaTime;
    entity.transform_y_array[entity.eid]! += entity.velocity_vy_array[entity.eid]! * deltaTime;
  });

// Run all systems
world.runSystems(deltaTime);
```

**When to use:** Production systems, best balance of speed and maintainability.

</details>

### 3. Ergonomic API (Developer-Friendly)

System builder with cached field access — **~3× slower than RAW**, cleanest syntax.

<details>
<summary><strong>Example: Movement System</strong></summary>

```typescript
world
  .addSystem()
  .query(Transform, Velocity)
  .fields([
    { transform: ['x', 'y'] },
    { velocity: ['vx', 'vy'] }
  ])
  .run((entity, deltaTime) => {
    // Property-like syntax (cached behind the scenes)
    entity.transform_x += entity.velocity_vx * deltaTime;
    entity.transform_y += entity.velocity_vy * deltaTime;
  });

world.runSystems(deltaTime);
```

**When to use:** Prototyping, non-critical systems, prioritizing code clarity.

</details>

### EntityHandle Fluent API

Chainable interface for entity operations — works with all patterns.

<details>
<summary><strong>Example: Entity Creation</strong></summary>

```typescript
// Fluent chaining for spawning
const player = world.entity(world.spawn())
  .add(Transform, { x: 100, y: 200, rotation: 0 })
  .add(Health, { current: 100, max: 100 })
  .add(Velocity, { vx: 0, vy: 0 });

// Update operations
player
  .update(Transform, { x: 150 })
  .update(Health, { current: 50 });

// Mix with raw queries
for (const id of world.query(Transform, Velocity)) {
  const entity = world.entity(id);
  const t = entity.get(Transform);
  entity.update(Transform, { x: t.x + 10 });
}
```

</details>

## System Builder Advanced

<details>
<summary><strong>Conditional Systems</strong></summary>

```typescript
// Only run when condition is met
world
  .addSystem()
  .query(Health)
  .fields([{ health: ['current', 'max'] }])
  .when((entity) => entity.health_current > 0 && entity.health_current < entity.health_max)
  .run((entity, deltaTime) => {
    entity.health_current += 5 * deltaTime;
  });
```

</details>

<details>
<summary><strong>Cross-Entity Reads</strong></summary>

```typescript
// Cache arrays for reading other entities
const healthCurrent = world.getFieldArray(Health, 'current');
const armorValue = world.getFieldArray(Armor, 'value');

world
  .addSystem()
  .query(Damage, Target)
  .fields([
    { damage: ['amount'] },
    { target: ['entityId'] }
  ])
  .run((entity, deltaTime, world) => {
    const targetId = entity.target_entityId;
    if (!world.isAlive(targetId)) return;

    let damageDealt = entity.damage_amount;

    // Read from other entity via cached arrays
    if (world.has(targetId, Armor)) {
      damageDealt -= armorValue[targetId]! * 0.1;
    }

    healthCurrent[targetId]! -= damageDealt;
  });
```

</details>

<details>
<summary><strong>Despawning Entities</strong></summary>

```typescript
world
  .addSystem()
  .query(Health)
  .fields([{ health: ['current'] }])
  .when((entity) => entity.health_current <= 0)
  .run((entity, deltaTime, world) => {
    world.despawn(entity.eid);
  });
```

</details>

## Performance

10,000 entities, 11 systems, 60 frames:

| API       | Frame Time | When to Use                           |
|-----------|------------|---------------------------------------|
| RAW       | **1.12 ms**| Critical hot paths, maximum speed     |
| Hybrid    | **2.23 ms**| Production (best balance)             |
| Ergonomic | **3.37 ms**| Prototyping, non-critical systems     |

All modes hit **60 FPS** at 50k entities. See [benchmarks/ecs](../../../benchmarks/ecs) for details.

## API Reference

### World

<details>
<summary><strong>Entity Management</strong></summary>

```typescript
// Spawn/despawn
const eid = world.spawn();
world.despawn(eid);
world.isAlive(eid);

// Component operations
world.add(eid, Transform, { x: 0, y: 0, rotation: 0 });
world.has(eid, Transform);
world.get(eid, Transform);
world.set(eid, Transform, { x: 100, y: 200, rotation: 0 });
world.update(eid, Transform, { x: 150 }); // Partial update
world.remove(eid, Transform);

// Queries
for (const eid of world.query(Transform, Velocity)) {
  // Only entities with BOTH components
}

// Direct array access (RAW API)
const transformX = world.getFieldArray(Transform, 'x');
```

</details>

<details>
<summary><strong>System Builder</strong></summary>

```typescript
world
  .addSystem()
  .query(Component1, Component2)          // Required components
  .fields([                                // Fields to access
    { comp1: ['field1', 'field2'] },
    { comp2: ['field3'] }
  ])
  .when((entity) => entity.comp1_field1 > 0)  // Optional filter
  .run((entity, deltaTime, world) => {    // System logic
    entity.comp1_field1 += deltaTime;
  });

// Execute all systems
world.runSystems(deltaTime);
```

</details>

### EntityHandle

<details>
<summary><strong>Fluent Operations</strong></summary>

```typescript
const entity = world.entity(eid);

// Chaining
entity
  .add(Transform, { x: 0, y: 0, rotation: 0 })
  .add(Velocity, { vx: 10, vy: 20 })
  .update(Health, { current: 50 });

// Access
const t = entity.get(Transform);
const x = entity.getField(Transform, 'x');
const array = entity.field(Transform, 'x'); // TypedArray

// Lifecycle
entity.has(Transform);
entity.remove(Transform);
entity.despawn();
entity.isAlive();
```

</details>


## Best Practices

### Choose the Right API

```typescript
// ✓ RAW API: Critical hot paths
const entities = world.query(Transform, Velocity);
for (let i = 0; i < entities.length; i++) {
  transformX[entities[i]!]! += velocityVx[entities[i]!]! * dt;
}

// ✓ Hybrid API: Production systems
world.addSystem().query(Transform, Velocity).fields([...]).run(...);

// ✓ Ergonomic API: Prototyping, non-critical
world.addSystem().query(Transform).fields([...]).run((e) => e.transform_x += 1);
```

### Use Partial Updates

```typescript
// ✓ Good: Update only what changed
world.update(eid, Transform, { x: newX });

// ✗ Bad: Get + spread + set
const t = world.get(eid, Transform);
world.set(eid, Transform, { ...t, x: newX });
```

### Batch Queries

```typescript
// ✓ Good: One query, many operations
for (const eid of world.query(Transform, Velocity)) {
  // Process all at once
}

// ✗ Bad: Individual checks
for (const eid of world.getEntities()) {
  if (world.has(eid, Transform) && world.has(eid, Velocity)) {
    // Slower
  }
}
```

### Keep Components Small

```typescript
// ✓ Good: Small, focused
const Transform = defineComponent('Transform', { x: f32, y: f32, rotation: f32 });
const Velocity = defineComponent('Velocity', { vx: f32, vy: f32 });

// ✗ Bad: Monolithic
const Entity = defineComponent('Entity', { x, y, rotation, vx, vy, health, ... });
```

## Integration

Components use the same schema for storage AND network:

```typescript
const Transform = defineComponent('Transform', {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
});

// Use in ECS
world.add(eid, Transform, { x: 100, y: 200 });

// Use in snapshots (same schema!)
snapshotRegistry.register('transform', Transform.arrayCodec);
```

See [Protocol Layer](../protocol/README.md) and [Networking](../net/README.md).

<details>
<summary><strong>Details for Nerds 🤓</strong></summary>

### System Builder Design

The system builder API exists because **raw queries don't give you field access**:

```typescript
// ✗ Raw query: No direct field access
for (const eid of world.query(Transform, Velocity)) {
  const t = world.get(eid, Transform);  // Object allocation
  const v = world.get(eid, Velocity);   // Object allocation
  world.update(eid, Transform, { x: t.x + v.vx * dt });
}

// ✓ System builder: Pre-cached field arrays
world.addSystem()
  .query(Transform, Velocity)
  .fields([
    { transform: ['x', 'y'] },
    { velocity: ['vx', 'vy'] }
  ])
  .run((entity, dt) => {
    // HYBRID: Direct array access
    entity.transform_x_array[entity.eid] += entity.velocity_vx_array[entity.eid] * dt;

    // ERGONOMIC: Cached getter/setter (looks like a field, but isn't)
    entity.transform_x += entity.velocity_vx * dt;
  });
```

**Why `.fields()`?**
- Pre-fetches TypedArrays once (not per-entity)
- Flattens nested access: `entity.transform_x` instead of `entity.transform.x`
- JIT-friendly: consistent shape, inline caching works better

**Hybrid vs Ergonomic:**
- **Hybrid**: `entity.field_array[entity.eid]` — explicit array indexing (~2× slower than RAW)
- **Ergonomic**: `entity.field` — looks like a field, actually a cached getter/setter (~3× slower than RAW)

Both modes cache the arrays **once per system**, not per entity. The overhead is JIT warmup + property access, not array lookups.

### Memory Layout: SoA

Murow uses **Structure of Arrays** (not Array of Structures):

```
// AoS (most engines): [ { x, y, rot }, { x, y, rot }, ... ]
// SoA (murow):        Float32Array[ x0, x1, x2, ... ]
//                     Float32Array[ y0, y1, y2, ... ]
```

**Why?** Cache-friendly field iteration, SIMD-friendly, native TypedArray ops.

### Query Optimizations

- **Persistent caching** — Results cached until archetype changes (16-473× speedup)
- **Reusable buffers** — Zero allocations for repeated queries
- **Bitmask caching** — Query masks computed once
- **Unrolled loops** — Hand-optimized for 1-4 mask words (up to 128 components)
- **Write cursor pattern** — Avoids array.length manipulation

### Component Storage

- **Array-indexed stores** — Direct index, no Map lookups
- **Index on component** — `component.__worldIndex` stored for O(1) access
- **Cached first mask word** — Fast path for <32 components (99% of games)

### Entity Management

- **Ring buffer free list** — Power-of-2 size for bitwise modulo (`& mask` vs `% size`)
- **Swap-remove despawn** — O(1) removal from alive entities array
- **Alive flag array** — O(1) alive checks (Uint8Array, no Set)

### Bitmask Operations

- **Bitwise shifts** — `>>>5` (div 32), `&31` (mod 32) instead of `/` and `%`
- **Multi-word support** — Scales to 1000s of components (32 per word)
- **Unrolled matching** — Specialized code for 1/2/3/4 words
- **Early termination** — Short-circuit on first failed mask

### Benchmark Notes

**11-system simulation (5-run avg, Intel i5-2400 @ 3.4GHz, 2011 CPU)**

| Entities | RAW     | Hybrid  | Ergonomic | vs Bevy (Rust) |
|----------|---------|---------|-----------|----------------|
| 1,000    | 0.13 ms | 0.24 ms | 0.37 ms   | ~2× slower     |
| 10,000   | 1.12 ms | 2.23 ms | 3.37 ms   | ~2.6× slower   |
| 50,000   | 8.18 ms | 11.29 ms| 17.43 ms  | ~3.8× slower   |
| 100,000  | 21.39 ms| 22.83 ms| 35.07 ms  | ~4.8× slower   |

**Variance (max/P50 ratio at 100k entities):**
- Murow: **~1.6-1.8×** (all modes)
- Bevy: ~2.7×
- bitECS: ~45.6× (extreme GC spikes)

Murow has **better variance control than Bevy** despite being TS.

</details>

## See Also

- [BinaryCodec](../core/binary-codec) — Schema definitions
- [PooledCodec](../core/pooled-codec) — Zero-copy serialization
- [Networking](../net) — Client/Server integration
- [Benchmarks](../../../benchmarks/ecs) — Performance comparisons

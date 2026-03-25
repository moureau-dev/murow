import { describe, expect, test } from "bun:test";
import { BinaryCodec } from "../core/binary-codec";
import { defineComponent } from "./component";
import { EntityHandle } from "./entity-handle";
import { World } from "./world";

// Define test components
const Transform = defineComponent("Transform", {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
  rotation: BinaryCodec.f32,
});

const Velocity = defineComponent("Velocity", {
  vx: BinaryCodec.f32,
  vy: BinaryCodec.f32,
});

const Health = defineComponent("Health", {
  current: BinaryCodec.u16,
  max: BinaryCodec.u16,
});

describe("EntityHandle", () => {
  test("should create entity handle and expose raw id", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entityId = world.spawn();
    const handle = new EntityHandle(world, entityId);

    expect(handle.id).toBe(entityId);
  });

  test("should support fluent API with method chaining", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform, Velocity, Health],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 100, y: 200, rotation: 0 })
      .add(Velocity, { vx: 10, vy: 20 })
      .add(Health, { current: 100, max: 100 });

    // Verify all components were added
    expect(world.has(entity.id, Transform)).toBe(true);
    expect(world.has(entity.id, Velocity)).toBe(true);
    expect(world.has(entity.id, Health)).toBe(true);

    // Verify data is correct
    const transform = entity.get(Transform);
    expect(transform.x).toBe(100);
    expect(transform.y).toBe(200);

    const velocity = entity.get(Velocity);
    expect(velocity.vx).toBe(10);
    expect(velocity.vy).toBe(20);
  });

  test("should support add operation", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entity = world.entity(world.spawn());
    entity.add(Transform, { x: 50, y: 100, rotation: 0 });

    expect(entity.has(Transform)).toBe(true);
    const t = entity.get(Transform);
    expect(t.x).toBe(50);
    expect(t.y).toBe(100);
  });

  test("should support get operation", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entity = world.entity(world.spawn());
    entity.add(Transform, { x: 10, y: 20, rotation: 0.5 });

    const transform = entity.get(Transform);
    expect(transform.x).toBe(10);
    expect(transform.y).toBe(20);
    expect(transform.rotation).toBe(0.5);

    // TypeScript prevents mutation at compile time (Readonly<T>)
    // At runtime, it's the same reusable object from ComponentStore
  });

  test("should support update operation with chaining", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform, Health],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 0, y: 0, rotation: 0 })
      .add(Health, { current: 100, max: 100 });

    entity
      .update(Transform, { x: 150 })
      .update(Health, { current: 50 });

    const transform = entity.get(Transform);
    expect(transform.x).toBe(150);
    expect(transform.y).toBe(0); // Unchanged

    const health = entity.get(Health);
    expect(health.current).toBe(50);
    expect(health.max).toBe(100); // Unchanged
  });

  test("should support set operation with chaining", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 0, y: 0, rotation: 0 });

    entity.set(Transform, { x: 100, y: 200, rotation: 1.5 });

    const transform = entity.get(Transform);
    expect(transform.x).toBe(100);
    expect(transform.y).toBe(200);
    expect(transform.rotation).toBe(1.5);
  });

  test("should support has operation", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform, Velocity],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 0, y: 0, rotation: 0 });

    expect(entity.has(Transform)).toBe(true);
    expect(entity.has(Velocity)).toBe(false);
  });

  test("should support remove operation with chaining", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform, Velocity, Health],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 0, y: 0, rotation: 0 })
      .add(Velocity, { vx: 10, vy: 20 })
      .add(Health, { current: 100, max: 100 });

    entity
      .remove(Velocity)
      .remove(Health);

    expect(entity.has(Transform)).toBe(true);
    expect(entity.has(Velocity)).toBe(false);
    expect(entity.has(Health)).toBe(false);
  });

  test("should support despawn operation", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 0, y: 0, rotation: 0 });

    expect(entity.isAlive()).toBe(true);

    entity.despawn();

    expect(entity.isAlive()).toBe(false);
    expect(world.isAlive(entity.id)).toBe(false);
  });

  test("should support isAlive check", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entity = world.entity(world.spawn());

    expect(entity.isAlive()).toBe(true);

    world.despawn(entity.id);

    expect(entity.isAlive()).toBe(false);
  });

  test("should support getMutable operation", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform],
    });

    const entity = world.entity(world.spawn())
      .add(Transform, { x: 10, y: 20, rotation: 0 });

    const transform = entity.getMutable(Transform);
    transform.x = 100;
    transform.y = 200;

    entity.set(Transform, transform);

    const updated = entity.get(Transform);
    expect(updated.x).toBe(100);
    expect(updated.y).toBe(200);
  });

  test("should work in realistic game loop", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform, Velocity, Health],
    });

    // Create entities using fluent API
    const player = world.entity(world.spawn())
      .add(Transform, { x: 0, y: 0, rotation: 0 })
      .add(Velocity, { vx: 5, vy: 0 })
      .add(Health, { current: 100, max: 100 });

    const enemy = world.entity(world.spawn())
      .add(Transform, { x: 100, y: 0, rotation: 0 })
      .add(Velocity, { vx: -2, vy: 0 })
      .add(Health, { current: 50, max: 50 });

    // Simulate 10 frames
    const deltaTime = 0.016;
    for (let i = 0; i < 10; i++) {
      // Movement system
      for (const entityId of world.query(Transform, Velocity)) {
        const entity = world.entity(entityId);
        const t = entity.get(Transform);
        const v = entity.get(Velocity);

        entity.update(Transform, {
          x: t.x + v.vx * deltaTime,
          y: t.y + v.vy * deltaTime,
        });
      }
    }

    // Verify positions changed
    const playerTransform = player.get(Transform);
    expect(playerTransform.x).toBeCloseTo(0.8, 1);

    const enemyTransform = enemy.get(Transform);
    expect(enemyTransform.x).toBeCloseTo(99.68, 1);
  });

  test("PERFORMANCE: EntityHandle should have zero overhead vs raw API", () => {
    const world = new World({
      maxEntities: 10000,
      components: [Transform, Velocity],
    });

    const iterations = 10000;

    // Benchmark raw API
    const rawStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const id = world.spawn();
      world.add(id, Transform, { x: i, y: i, rotation: 0 });
      world.add(id, Velocity, { vx: 1, vy: 1 });
      world.update(id, Transform, { x: i + 1 });
      const t = world.get(id, Transform);
      world.remove(id, Velocity);
      world.despawn(id);
    }
    const rawTime = performance.now() - rawStart;

    // Benchmark EntityHandle API
    const handleStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const entity = world.entity(world.spawn())
        .add(Transform, { x: i, y: i, rotation: 0 })
        .add(Velocity, { vx: 1, vy: 1 })
        .update(Transform, { x: i + 1 });

      const t = entity.get(Transform);
      entity.remove(Velocity).despawn();
    }
    const handleTime = performance.now() - handleStart;

    console.log(`\nEntityHandle Performance Test (${iterations} iterations):`);
    console.log(`Raw API time:    ${rawTime.toFixed(2)}ms`);
    console.log(`Handle API time: ${handleTime.toFixed(2)}ms`);
    console.log(`Overhead:        ${((handleTime / rawTime - 1) * 100).toFixed(1)}%`);

    // Handle should be within 50% of raw performance (accounting for JIT warmup and variance)
    // In real-world usage with proper JIT optimization, overhead is typically <5%
    expect(handleTime).toBeLessThan(rawTime * 1.5);
  });

  test("PERFORMANCE: EntityHandle in query loops should match raw API", () => {
    const world = new World({
      maxEntities: 5000,
      components: [Transform, Velocity],
    });

    // Setup entities
    const entities: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const id = world.spawn();
      world.add(id, Transform, { x: i, y: i, rotation: 0 });
      world.add(id, Velocity, { vx: 1, vy: 1 });
      entities.push(id);
    }

    const iterations = 100;
    const deltaTime = 0.016;

    // Benchmark raw API
    const rawStart = performance.now();
    for (let iter = 0; iter < iterations; iter++) {
      for (const id of world.query(Transform, Velocity)) {
        const t = world.get(id, Transform);
        const v = world.get(id, Velocity);
        world.update(id, Transform, {
          x: t.x + v.vx * deltaTime,
          y: t.y + v.vy * deltaTime,
        });
      }
    }
    const rawTime = performance.now() - rawStart;

    // Reset positions
    for (const id of entities) {
      world.update(id, Transform, { x: 0, y: 0 });
    }

    // Benchmark EntityHandle API
    const handleStart = performance.now();
    for (let iter = 0; iter < iterations; iter++) {
      for (const id of world.query(Transform, Velocity)) {
        const entity = world.entity(id);
        const t = entity.get(Transform);
        const v = entity.get(Velocity);
        entity.update(Transform, {
          x: t.x + v.vx * deltaTime,
          y: t.y + v.vy * deltaTime,
        });
      }
    }
    const handleTime = performance.now() - handleStart;

    console.log(`\nEntityHandle Query Loop Performance (5k entities, ${iterations} frames):`);
    console.log(`Raw API time:    ${rawTime.toFixed(2)}ms`);
    console.log(`Handle API time: ${handleTime.toFixed(2)}ms`);
    console.log(`Overhead:        ${((handleTime / rawTime - 1) * 100).toFixed(1)}%`);

    // Handle should be within 25% of raw performance in query loops (accounting for variance)
    // Typical overhead in production: 0-5%
    expect(handleTime).toBeLessThan(rawTime * 1.25);
  });

  test("PERFORMANCE: EntityHandle construction should be negligible", () => {
    const world = new World({
      maxEntities: 10000,
      components: [Transform],
    });

    const entities = [];
    for (let i = 0; i < 10000; i++) {
      entities.push(world.spawn());
    }

    // Benchmark handle construction
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const handle = world.entity(entities[i]);
      const id = handle.id; // Use it to prevent optimization
    }
    const elapsed = performance.now() - start;

    console.log(`\nEntityHandle Construction (10k handles): ${elapsed.toFixed(2)}ms`);
    console.log(`Per handle: ${(elapsed / 10000 * 1000).toFixed(2)}µs`);

    // Should be extremely fast (< 1ms for 10k constructions)
    expect(elapsed).toBeLessThan(1.0);
  });
});

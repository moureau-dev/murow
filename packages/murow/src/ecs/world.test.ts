import { describe, expect, test } from "bun:test";
import { BinaryCodec } from "../core/binary-codec";
import { Component, defineComponent } from "./component";
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

describe("World", () => {
  test("should create a world with components", () => {
    const world = new World({
      maxEntities: 100,
      components: [Transform, Velocity, Health],
    });

    expect(world.getMaxEntities()).toBe(100);
    expect(world.getEntityCount()).toBe(0);
  });

  test("should spawn entities", () => {
    const world = new World({
      components: [Transform],
    });

    const e1 = world.spawn();
    const e2 = world.spawn();
    const e3 = world.spawn();

    expect(world.getEntityCount()).toBe(3);
    expect(world.isAlive(e1)).toBe(true);
    expect(world.isAlive(e2)).toBe(true);
    expect(world.isAlive(e3)).toBe(true);
  });

  test("should despawn entities and reuse IDs", () => {
    const world = new World({
      components: [Transform],
    });

    const e1 = world.spawn();
    const e2 = world.spawn();

    world.despawn(e1);
    expect(world.isAlive(e1)).toBe(false);
    expect(world.getEntityCount()).toBe(1);

    const e3 = world.spawn();
    expect(e3).toBe(e1); // Should reuse the freed ID
    expect(world.getEntityCount()).toBe(2);
  });

  test("should add and get components", () => {
    const world = new World({
      components: [Transform, Velocity],
    });

    const entity = world.spawn();

    world.add(entity, Transform, { x: 100, y: 200, rotation: 0 });
    world.add(entity, Velocity, { vx: 10, vy: 20 });

    const transform = world.get(entity, Transform);
    expect(transform.x).toBe(100);
    expect(transform.y).toBe(200);
    expect(transform.rotation).toBe(0);

    const velocity = world.get(entity, Velocity);
    expect(velocity.vx).toBe(10);
    expect(velocity.vy).toBe(20);
  });

  test("should set component data", () => {
    const world = new World({
      components: [Transform],
    });

    const entity = world.spawn();
    world.add(entity, Transform, { x: 0, y: 0, rotation: 0 });

    world.set(entity, Transform, { x: 50, y: 75, rotation: 3.14 });

    const transform = world.get(entity, Transform);
    expect(transform.x).toBe(50);
    expect(transform.y).toBe(75);
    expect(transform.rotation).toBeCloseTo(3.14, 2);
  });

  test("should update partial component data", () => {
    const world = new World({
      components: [Transform],
    });

    const entity = world.spawn();
    world.add(entity, Transform, { x: 100, y: 200, rotation: 0 });

    // Update only x
    world.update(entity, Transform, { x: 150 });

    const transform = world.get(entity, Transform);
    expect(transform.x).toBe(150);
    expect(transform.y).toBe(200); // Unchanged
    expect(transform.rotation).toBe(0); // Unchanged
  });

  test("should check if entity has component", () => {
    const world = new World({
      components: [Transform, Velocity],
    });

    const entity = world.spawn();
    world.add(entity, Transform, { x: 0, y: 0, rotation: 0 });

    expect(world.has(entity, Transform)).toBe(true);
    expect(world.has(entity, Velocity)).toBe(false);
  });

  test("should remove components", () => {
    const world = new World({
      components: [Transform, Velocity],
    });

    const entity = world.spawn();
    world.add(entity, Transform, { x: 0, y: 0, rotation: 0 });
    world.add(entity, Velocity, { vx: 10, vy: 20 });

    expect(world.has(entity, Velocity)).toBe(true);

    world.remove(entity, Velocity);

    expect(world.has(entity, Velocity)).toBe(false);
    expect(world.has(entity, Transform)).toBe(true);
  });

  test("should query entities with specific components", () => {
    const world = new World({
      components: [Transform, Velocity, Health],
    });

    // Entity with Transform + Velocity
    const e1 = world.spawn();
    world.add(e1, Transform, { x: 0, y: 0, rotation: 0 });
    world.add(e1, Velocity, { vx: 10, vy: 20 });

    // Entity with only Transform
    const e2 = world.spawn();
    world.add(e2, Transform, { x: 100, y: 100, rotation: 0 });

    // Entity with Transform + Velocity + Health
    const e3 = world.spawn();
    world.add(e3, Transform, { x: 50, y: 50, rotation: 0 });
    world.add(e3, Velocity, { vx: 5, vy: 5 });
    world.add(e3, Health, { current: 100, max: 100 });

    // Query for Transform + Velocity (should return e1 and e3)
    const results = Array.from(world.query(Transform, Velocity));
    expect(results.length).toBe(2);
    expect(results).toContain(e1);
    expect(results).toContain(e3);
    expect(results).not.toContain(e2);
  });

  test("should handle queries with no matches", () => {
    const world = new World({
      components: [Transform, Velocity],
    });

    const entity = world.spawn();
    world.add(entity, Transform, { x: 0, y: 0, rotation: 0 });

    const results = Array.from(world.query(Transform, Velocity));
    expect(results.length).toBe(0);
  });

  test("should iterate and update entities in query", () => {
    const world = new World({
      components: [Transform, Velocity],
    });

    // Create moving entities
    for (let i = 0; i < 5; i++) {
      const entity = world.spawn();
      world.add(entity, Transform, { x: 0, y: 0, rotation: 0 });
      world.add(entity, Velocity, { vx: 10, vy: 20 });
    }

    // Simulate movement (using update() - correct pattern)
    const deltaTime = 0.016; // 16ms
    for (const entity of world.query(Transform, Velocity)) {
      const transform = world.get(entity, Transform); // Readonly
      const velocity = world.get(entity, Velocity); // Readonly

      // Use update() to modify (correct!)
      world.update(entity, Transform, {
        x: transform.x + velocity.vx * deltaTime,
        y: transform.y + velocity.vy * deltaTime,
      });
    }

    // Verify all entities moved
    for (const entity of world.query(Transform)) {
      const transform = world.get(entity, Transform);
      expect(transform.x).toBeCloseTo(0.16, 2);
      expect(transform.y).toBeCloseTo(0.32, 2);
    }
  });

  test("should handle many entities efficiently", () => {
    const world = new World({
      maxEntities: 10000,
      components: [Transform, Velocity],
    });

    // Spawn 1000 entities
    const entities = [];
    for (let i = 0; i < 1000; i++) {
      const entity = world.spawn();
      world.add(entity, Transform, { x: i, y: i * 2, rotation: 0 });
      world.add(entity, Velocity, { vx: 1, vy: 1 });
      entities.push(entity);
    }

    expect(world.getEntityCount()).toBe(1000);

    // Query should return all entities
    const results = Array.from(world.query(Transform, Velocity));
    expect(results.length).toBe(1000);

    // Update all entities (performance test using update())
    const start = performance.now();
    for (const entity of world.query(Transform, Velocity)) {
      const transform = world.get(entity, Transform);
      const velocity = world.get(entity, Velocity);

      world.update(entity, Transform, {
        x: transform.x + velocity.vx,
        y: transform.y + velocity.vy,
      });
    }
    const elapsed = performance.now() - start;

    // Should complete in reasonable time (< 10ms for 1000 entities)
    expect(elapsed).toBeLessThan(10);
  });

  test("should clear component data when entity is despawned", () => {
    const world = new World({
      components: [Transform],
    });

    const entity = world.spawn();
    world.add(entity, Transform, { x: 100, y: 200, rotation: 3.14 });

    world.despawn(entity);

    // Spawn a new entity with the same ID
    const newEntity = world.spawn();
    expect(newEntity).toBe(entity); // Same ID reused

    // Should not have Transform component
    expect(world.has(newEntity, Transform)).toBe(false);
  });

  test("should throw error when accessing non-existent component", () => {
    const world = new World({
      components: [Transform],
    });

    const entity = world.spawn();

    expect(() => world.get(entity, Transform)).toThrow();
    expect(() => world.set(entity, Transform, { x: 0, y: 0, rotation: 0 })).toThrow();
  });

  test("should support many components with dynamic scaling", () => {
    // Create 128 components (4 words)
    const components: Component[] = [];
    for (let i = 0; i < 128; i++) {
      components.push(
        defineComponent(`Component${i}`, {
          value: BinaryCodec.u8,
        })
      );
    }

    // Should not throw - dynamic scaling
    expect(() => {
      new World({ components });
    }).not.toThrow();

    // Should also support more than 128 components
    const extra = defineComponent("Component128", { value: BinaryCodec.u8 });
    expect(() => {
      new World({ components: [...components, extra] });
    }).not.toThrow();
  });
});

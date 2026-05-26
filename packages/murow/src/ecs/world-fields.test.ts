import { describe, expect, test } from "bun:test";
import { BinaryCodec } from "../core/binary-codec";
import { defineComponent } from "./component";
import { World } from "./world";

// Mixed-type schema to exercise every typed-array variant getFieldArray can return.
const Mixed = defineComponent("Mixed", {
  f: BinaryCodec.f32,
  i: BinaryCodec.i32,
  u: BinaryCodec.u32,
  s: BinaryCodec.u16,
  b: BinaryCodec.u8,
});

const Transform = defineComponent("Transform", {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
});

const Velocity = defineComponent("Velocity", {
  vx: BinaryCodec.f32,
  vy: BinaryCodec.f32,
});

const Unregistered = defineComponent("Unregistered", {
  v: BinaryCodec.f32,
});

describe("World.fields", () => {
  test("returns a bundle with one typed array per schema field", () => {
    const world = new World({ maxEntities: 16, components: [Mixed] });
    const fields = world.fields(Mixed);

    expect(Object.keys(fields).sort()).toEqual(["b", "f", "i", "s", "u"]);
    expect(fields.f).toBeInstanceOf(Float32Array);
    expect(fields.i).toBeInstanceOf(Int32Array);
    expect(fields.u).toBeInstanceOf(Uint32Array);
    expect(fields.s).toBeInstanceOf(Uint16Array);
    expect(fields.b).toBeInstanceOf(Uint8Array);
  });

  test("returns the same object on every call (zero garbage)", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const a = world.fields(Transform);
    const b = world.fields(Transform);
    const c = world.fields(Transform);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("returns identical typed-array references to getFieldArray", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const fields = world.fields(Transform);
    expect(fields.x).toBe(world.getFieldArray(Transform, "x") as Float32Array);
    expect(fields.y).toBe(world.getFieldArray(Transform, "y") as Float32Array);
  });

  test("returns distinct bundles for distinct components", () => {
    const world = new World({
      maxEntities: 16,
      components: [Transform, Velocity],
    });
    const transform = world.fields(Transform);
    const velocity = world.fields(Velocity);
    expect(transform).not.toBe(velocity);
    expect(transform.x).not.toBe(velocity.vx);
  });

  test("writes through the bundle land in the underlying store", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const eid = world.spawn();
    world.add(eid, Transform, { x: 0, y: 0 });

    const fields = world.fields(Transform);
    fields.x[eid] = 7;
    fields.y[eid] = 11;

    const view = world.get(eid, Transform);
    expect(view.x).toBe(7);
    expect(view.y).toBe(11);
  });

  test("reads through the bundle see writes from world.add / world.update", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const eid = world.spawn();
    world.add(eid, Transform, { x: 3, y: 4 });

    const fields = world.fields(Transform);
    expect(fields.x[eid]).toBe(3);
    expect(fields.y[eid]).toBe(4);

    world.update(eid, Transform, { x: 99 });
    expect(fields.x[eid]).toBe(99);
  });

  test("bundle is frozen — cannot reassign field arrays", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const fields = world.fields(Transform) as Record<string, unknown>;
    expect(Object.isFrozen(fields)).toBe(true);

    // In strict mode (the netcode/ecs packages compile to strict) this
    // throws; in sloppy mode it would silently no-op. Either way the
    // value must not change.
    const originalX = fields.x;
    expect(() => {
      "use strict";
      (fields as Record<string, unknown>).x = new Float32Array(8);
    }).toThrow();
    expect(fields.x).toBe(originalX);
  });

  test("typed-array contents are writable even though the bundle is frozen", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const eid = world.spawn();
    world.add(eid, Transform, { x: 0, y: 0 });

    const fields = world.fields(Transform);
    fields.x[eid] = 42;
    expect(fields.x[eid]).toBe(42);
  });

  test("throws on an unregistered component", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    expect(() => world.fields(Unregistered)).toThrow(/not registered/i);
  });

  test("survives across the World lifecycle (spawn, despawn, respawn)", () => {
    const world = new World({ maxEntities: 16, components: [Transform] });
    const fields = world.fields(Transform);

    const eid1 = world.spawn();
    world.add(eid1, Transform, { x: 1, y: 2 });
    expect(fields.x[eid1]).toBe(1);

    world.despawn(eid1);

    const eid2 = world.spawn();
    world.add(eid2, Transform, { x: 5, y: 6 });

    // Same bundle reference, observes the new entity.
    expect(world.fields(Transform)).toBe(fields);
    expect(fields.x[eid2]).toBe(5);
  });

  test("works with maxEntities default (no explicit config value)", () => {
    const world = new World({ components: [Transform] });
    const fields = world.fields(Transform);
    expect(fields.x).toBeInstanceOf(Float32Array);
    expect(fields.x.length).toBeGreaterThan(0);
  });
});

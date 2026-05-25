import { describe, test, expect } from 'bun:test';
import { World } from './world';
import { defineComponent } from './component';
import { f32 } from '../core/binary-codec';

describe('World dirty tracking', () => {
  const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: { rate: 'every-tick', interest: 'aoi' },
  });

  const Local = defineComponent('Local', { x: f32 });

  function makeWorld() {
    return new World({ maxEntities: 100, components: [Position, Local] });
  }

  test('add() marks the entity dirty for a synced component', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Position, { x: 1, y: 2 });
    expect(w.isDirty(e, Position)).toBe(true);
  });

  test('add() does not mark dirty for an unsynced component', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Local, { x: 1 });
    expect(w.isDirty(e, Local)).toBe(false);
  });

  test('update() marks the entity dirty for a synced component', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Position, { x: 0, y: 0 });
    w.clearDirty(e, Position);
    expect(w.isDirty(e, Position)).toBe(false);

    w.update(e, Position, { x: 10 });
    expect(w.isDirty(e, Position)).toBe(true);
  });

  test('set() marks the entity dirty for a synced component', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Position, { x: 0, y: 0 });
    w.clearDirty(e, Position);

    w.set(e, Position, { x: 99, y: 99 });
    expect(w.isDirty(e, Position)).toBe(true);
  });

  test('clearDirty() resets the bit', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Position, { x: 0, y: 0 });
    expect(w.isDirty(e, Position)).toBe(true);
    w.clearDirty(e, Position);
    expect(w.isDirty(e, Position)).toBe(false);
  });

  test('forEachDirty visits exactly the dirty entities for a component', () => {
    const w = makeWorld();
    const a = w.spawn();
    const b = w.spawn();
    const c = w.spawn();
    w.add(a, Position, { x: 1, y: 1 });
    w.add(b, Position, { x: 2, y: 2 });
    w.add(c, Position, { x: 3, y: 3 });

    w.clearDirty(b, Position);

    const seen: number[] = [];
    w.forEachDirty(Position, (e) => seen.push(e));
    seen.sort((x, y) => x - y);
    expect(seen).toEqual([a, c].sort((x, y) => x - y));
  });

  test('forEachDirty is a no-op for unsynced components', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Local, { x: 1 });
    let count = 0;
    w.forEachDirty(Local, () => count++);
    expect(count).toBe(0);
  });

  test('isDirty is false for unsynced components even after writes', () => {
    const w = makeWorld();
    const e = w.spawn();
    w.add(e, Local, { x: 1 });
    w.update(e, Local, { x: 2 });
    expect(w.isDirty(e, Local)).toBe(false);
  });

  test('clearAllDirty wipes every synced component bitmap', () => {
    const w = makeWorld();
    const a = w.spawn();
    const b = w.spawn();
    w.add(a, Position, { x: 1, y: 1 });
    w.add(b, Position, { x: 2, y: 2 });
    w.clearAllDirty();
    expect(w.isDirty(a, Position)).toBe(false);
    expect(w.isDirty(b, Position)).toBe(false);
  });
});

describe('System-builder dirty tracking', () => {
  const Position = defineComponent('Position', {
    schema: { x: f32, y: f32 },
    sync: { rate: 'every-tick', interest: 'aoi' },
  });

  const Local = defineComponent('Local', { x: f32 });

  test('a system over a synced component marks visited entities dirty', () => {
    const w = new World({ maxEntities: 100, components: [Position] });
    const a = w.spawn();
    const b = w.spawn();
    w.add(a, Position, { x: 0, y: 0 });
    w.add(b, Position, { x: 0, y: 0 });
    w.clearAllDirty();

    w.addSystem()
      .query(Position)
      .fields([{ position: ['x'] }])
      .run((entity) => {
        entity.position_x += 1;
      });

    w.runSystems(0.016);

    expect(w.isDirty(a, Position)).toBe(true);
    expect(w.isDirty(b, Position)).toBe(true);
  });

  test('a system over an unsynced component does not allocate dirty work', () => {
    const w = new World({ maxEntities: 100, components: [Local] });
    const e = w.spawn();
    w.add(e, Local, { x: 0 });

    w.addSystem()
      .query(Local)
      .fields([{ local: ['x'] }])
      .run((entity) => {
        entity.local_x += 1;
      });

    w.runSystems(0.016);
    expect(w.isDirty(e, Local)).toBe(false);
  });

  test('predicate-filtered systems only mark dirty for entities that pass', () => {
    const w = new World({ maxEntities: 100, components: [Position] });
    const a = w.spawn();
    const b = w.spawn();
    w.add(a, Position, { x: 0, y: 0 });
    w.add(b, Position, { x: 100, y: 0 });
    w.clearAllDirty();

    w.addSystem()
      .query(Position)
      .fields([{ position: ['x'] }])
      .when((e) => e.position_x < 50)
      .run((entity) => {
        entity.position_x += 1;
      });

    w.runSystems(0.016);

    expect(w.isDirty(a, Position)).toBe(true);
    expect(w.isDirty(b, Position)).toBe(false);
  });
});

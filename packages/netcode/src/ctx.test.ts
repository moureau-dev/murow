import { describe, expect, test } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { makeFieldsAccessor, makeMarkDirty } from './ctx';

describe('makeFieldsAccessor', () => {
    const NetPosition = defineComponent('NetPosition', {
        schema: { x: f32, z: f32 },
        sync: { rate: 'every-tick', interest: 'global' },
    });

    const LocalVelocity = defineComponent('LocalVelocity', {
        vx: f32,
        vy: f32,
    });

    test('marks the entity dirty for a networked component', () => {
        const world = new World({ maxEntities: 8, components: [NetPosition, LocalVelocity] });
        const entity = world.spawn();
        world.add(entity, NetPosition, { x: 0, z: 0 });
        // Clear any dirty bit set by world.add itself
        world.clearDirty(entity, NetPosition);
        expect(world.isDirty(entity, NetPosition)).toBe(false);

        const fields = makeFieldsAccessor(world, entity);
        fields(NetPosition);

        expect(world.isDirty(entity, NetPosition)).toBe(true);
    });

    test('does not mark dirty for non-networked components', () => {
        const world = new World({ maxEntities: 8, components: [NetPosition, LocalVelocity] });
        const entity = world.spawn();
        world.add(entity, LocalVelocity, { vx: 0, vy: 0 });
        // LocalVelocity has no __sync, so it has no dirty bitmap; isDirty returns false.
        expect(world.isDirty(entity, LocalVelocity)).toBe(false);

        const fields = makeFieldsAccessor(world, entity);
        fields(LocalVelocity);

        expect(world.isDirty(entity, LocalVelocity)).toBe(false);
    });

    test('returns the same bundle as world.fields()', () => {
        const world = new World({ maxEntities: 8, components: [NetPosition] });
        const entity = world.spawn();
        world.add(entity, NetPosition, { x: 0, z: 0 });

        const fields = makeFieldsAccessor(world, entity);
        expect(fields(NetPosition)).toBe(world.fields(NetPosition) as any);
    });
});

describe('makeMarkDirty', () => {
    const NetPosition = defineComponent('NetPosition', {
        schema: { x: f32, z: f32 },
        sync: { rate: 'every-tick', interest: 'global' },
    });

    const LocalVelocity = defineComponent('LocalVelocity', {
        vx: f32,
        vy: f32,
    });

    test('defaults to ctx entity', () => {
        const world = new World({ maxEntities: 8, components: [NetPosition] });
        const entity = world.spawn();
        world.add(entity, NetPosition, { x: 0, z: 0 });
        world.clearDirty(entity, NetPosition);

        const markDirty = makeMarkDirty(world, entity);
        markDirty(NetPosition);

        expect(world.isDirty(entity, NetPosition)).toBe(true);
    });

    test('accepts an explicit entity argument', () => {
        const world = new World({ maxEntities: 8, components: [NetPosition] });
        const ctxEntity = world.spawn();
        const targetEntity = world.spawn();
        world.add(ctxEntity, NetPosition, { x: 0, z: 0 });
        world.add(targetEntity, NetPosition, { x: 1, z: 1 });
        world.clearDirty(ctxEntity, NetPosition);
        world.clearDirty(targetEntity, NetPosition);

        const markDirty = makeMarkDirty(world, ctxEntity);
        markDirty(NetPosition, targetEntity);

        expect(world.isDirty(ctxEntity, NetPosition)).toBe(false);
        expect(world.isDirty(targetEntity, NetPosition)).toBe(true);
    });

    test('no-ops for components without sync metadata', () => {
        const world = new World({ maxEntities: 8, components: [LocalVelocity] });
        const entity = world.spawn();
        world.add(entity, LocalVelocity, { vx: 0, vy: 0 });

        const markDirty = makeMarkDirty(world, entity);
        // Should not throw, should leave dirty state alone (there is no bitmap).
        expect(() => markDirty(LocalVelocity)).not.toThrow();
        expect(world.isDirty(entity, LocalVelocity)).toBe(false);
    });

    test('no-ops if component was never registered with the world', () => {
        const NetA = defineComponent('NetA', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const NetB = defineComponent('NetB', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const world = new World({ maxEntities: 8, components: [NetA] });
        const entity = world.spawn();

        const markDirty = makeMarkDirty(world, entity);
        // NetB has no __worldIndex -> no-op
        expect(() => markDirty(NetB)).not.toThrow();
    });

    test('accepts an array of components, default entity', () => {
        const NetA = defineComponent('NetA', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const NetB = defineComponent('NetB', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const world = new World({ maxEntities: 8, components: [NetA, NetB] });
        const entity = world.spawn();
        world.add(entity, NetA, { v: 0 });
        world.add(entity, NetB, { v: 0 });
        world.clearDirty(entity, NetA);
        world.clearDirty(entity, NetB);

        const markDirty = makeMarkDirty(world, entity);
        markDirty([NetA, NetB]);

        expect(world.isDirty(entity, NetA)).toBe(true);
        expect(world.isDirty(entity, NetB)).toBe(true);
    });

    test('accepts an array of components with an explicit entity', () => {
        const NetA = defineComponent('NetA', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const NetB = defineComponent('NetB', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const world = new World({ maxEntities: 8, components: [NetA, NetB] });
        const ctxEntity = world.spawn();
        const target = world.spawn();
        world.add(ctxEntity, NetA, { v: 0 });
        world.add(target, NetA, { v: 0 });
        world.add(target, NetB, { v: 0 });
        world.clearDirty(ctxEntity, NetA);
        world.clearDirty(target, NetA);
        world.clearDirty(target, NetB);

        const markDirty = makeMarkDirty(world, ctxEntity);
        markDirty([NetA, NetB], target);

        expect(world.isDirty(ctxEntity, NetA)).toBe(false);
        expect(world.isDirty(target, NetA)).toBe(true);
        expect(world.isDirty(target, NetB)).toBe(true);
    });

    test('mixed array: skips unsynced components, marks synced ones', () => {
        const Synced = defineComponent('Synced', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const Local = defineComponent('Local', { v: f32 });
        const world = new World({ maxEntities: 8, components: [Synced, Local] });
        const entity = world.spawn();
        world.add(entity, Synced, { v: 0 });
        world.add(entity, Local, { v: 0 });
        world.clearDirty(entity, Synced);

        const markDirty = makeMarkDirty(world, entity);
        expect(() => markDirty([Synced, Local])).not.toThrow();

        expect(world.isDirty(entity, Synced)).toBe(true);
        expect(world.isDirty(entity, Local)).toBe(false);
    });

    test('empty array is a no-op', () => {
        const NetA = defineComponent('NetA', {
            schema: { v: f32 },
            sync: { rate: 'every-tick', interest: 'global' },
        });
        const world = new World({ maxEntities: 8, components: [NetA] });
        const entity = world.spawn();
        world.add(entity, NetA, { v: 0 });
        world.clearDirty(entity, NetA);

        const markDirty = makeMarkDirty(world, entity);
        expect(() => markDirty([])).not.toThrow();
        expect(world.isDirty(entity, NetA)).toBe(false);
    });
});

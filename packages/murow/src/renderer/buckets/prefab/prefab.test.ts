import { test, expect, describe } from 'bun:test';
import { PrefabBucket } from './prefab';

describe('PrefabBucket', () => {
    describe('3D — grid + cube', () => {
        test('starts empty', () => {
            const bucket = new PrefabBucket('3d');
            expect(bucket.loaded).toBe(false);
            expect(bucket.size).toBe(0);
        });

        test('add() chains and accumulates', () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'grid', id: 'floor', size: 10, step: 1, lineWidth: 0.01 })
                .add({ type: 'cube', id: 'box', size: 2 });
            expect(bucket.size).toBe(2);
        });

        test('load() parses grid and cube synchronously', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'grid', id: 'floor', size: 10, step: 1, lineWidth: 0.01 })
                .add({ type: 'cube', id: 'box', size: 2 });

            await bucket.load();

            expect(bucket.loaded).toBe(true);

            const floor = bucket.get('floor');
            expect(floor.type).toBe('grid');
            if (floor.type === 'grid') {
                expect(floor.size).toBe(10);
                expect(floor.step).toBe(1);
                expect(floor.lineWidth).toBe(0.01);
            }

            const box = bucket.get('box');
            expect(box.type).toBe('cube');
            if (box.type === 'cube') {
                expect(box.size).toBe(2);
            }
        });

        test('get() narrows per-id type after load', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'grid', id: 'g', size: 5, step: 1, lineWidth: 0.01 })
                .add({ type: 'cube', id: 'c', size: 3 });

            await bucket.load();

            // TypeScript narrows these at compile time; at runtime we verify shape
            const grid = bucket.get('g');
            expect(grid).toHaveProperty('size');
            expect(grid).toHaveProperty('step');

            const cube = bucket.get('c');
            expect(cube.size).toBe(3);
        });

        test('load() is idempotent', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'cube', id: 'x', size: 1 });
            await bucket.load();
            await bucket.load();
            expect(bucket.loaded).toBe(true);
            expect(bucket.size).toBe(1);
        });

        test('entries() returns all parsed prefabs', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'grid', id: 'g', size: 1, step: 1, lineWidth: 0.01 })
                .add({ type: 'cube', id: 'c', size: 1 });

            await bucket.load();
            const ids = bucket.entries().map(p => p.id);
            expect(ids).toEqual(['g', 'c']);
        });

        test('cube defaults size to 1', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'cube', id: 'default' });

            await bucket.load();
            const cube = bucket.get('default');
            expect(cube.size).toBe(1);
        });
    });

    describe('2D — spritesheets', () => {
        test('can create a 2D prefab bucket', () => {
            const bucket = new PrefabBucket('2d');
            expect(bucket.loaded).toBe(false);
            expect(bucket.size).toBe(0);
        });
    });

    describe('errors', () => {
        test('duplicate id throws on add()', () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'cube', id: 'a', size: 1 });
            expect(() => bucket.add({ type: 'cube', id: 'a', size: 2 }))
                .toThrow(/duplicate id 'a'/);
        });

        test('get() before load throws', () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'cube', id: 'a', size: 1 });
            expect(() => bucket.get('a' as never)).toThrow(/before load/);
        });

        test('get() with unknown id throws', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'cube', id: 'a', size: 1 });
            await bucket.load();
            expect(() => bucket.get('missing' as never)).toThrow(/unknown prefab id 'missing'/);
        });

        test('add() after load throws', async () => {
            const bucket = new PrefabBucket('3d')
                .add({ type: 'cube', id: 'a', size: 1 });
            await bucket.load();
            expect(() => bucket.add({ type: 'cube', id: 'b', size: 2 }))
                .toThrow(/frozen/);
        });

        test('entries() before load throws', () => {
            const bucket = new PrefabBucket('3d');
            expect(() => bucket.entries()).toThrow(/before load/);
        });
    });

    describe('composite spec', () => {
        test('composite parsers correctly', async () => {
            const bucket = new PrefabBucket('3d')
                .add({
                    type: 'composite',
                    id: 'group',
                    parts: [{ partId: 'a' }, { partId: 'b' }],
                });

            await bucket.load();
            const comp = bucket.get('group');
            expect(comp.type).toBe('composite');
        });
    });
});

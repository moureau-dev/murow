import { test, expect, describe, beforeAll } from 'bun:test';
import { AssetBucket } from './asset';

// Bun's test runner doesn't have a global Image constructor.
beforeAll(() => {
    (globalThis as Record<string, unknown>).Image = class MockImage {
        src = '';
        naturalWidth = 1;
        naturalHeight = 1;
        onload: (() => void) | null = null;
        onerror: ((err: unknown) => void) | null = null;
        decode() { return Promise.resolve(); }
    };
});

// 1×1 red pixel PNG
const RED_PIXEL_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

describe('AssetBucket', () => {
    describe('3D mode', () => {
        test('constructs empty', () => {
            const assets = new AssetBucket('3d');
            expect(assets.loaded).toBe(false);
        });

        test('textures and prefabs are accessible as properties', () => {
            const assets = new AssetBucket('3d');
            // Property access returns the inner buckets
            expect(assets.textures).toBeDefined();
            expect(assets.prefabs).toBeDefined();
            expect(assets.textures.loaded).toBe(false);
            expect(assets.prefabs.loaded).toBe(false);
        });

        test('chained textures + prefabs loads both', async () => {
            const assets = new AssetBucket('3d')
                .textures(({ bucket }) => bucket
                    .add({ type: 'texture', id: 'brick', src: RED_PIXEL_PNG })
                )
                .prefabs(({ bucket }) => bucket
                    .add({ type: 'cube', id: 'box', size: 2 })
            );

            // Property access for inner bucket state
            expect(assets.textures.size).toBe(1);
            expect(assets.prefabs.size).toBe(1);

            await assets.load();

            expect(assets.loaded).toBe(true);

            // Property access for individual items
            const tex = assets.textures.get('brick');
            expect(tex.type).toBe('texture');
            expect(tex.parsed).toBeDefined();

            const cube = assets.prefabs.get('box');
            expect(cube.type).toBe('cube');
        });

        test('load() is idempotent', async () => {
            const assets = new AssetBucket('3d')
                .textures(({ bucket }) => bucket
                    .add({ type: 'texture', id: 't', src: RED_PIXEL_PNG })
                )
                .prefabs(({ bucket }) => bucket
                    .add({ type: 'grid', id: 'g', size: 1, step: 1, lineWidth: 0.01 })
            );

            await assets.load();
            await assets.load();
            expect(assets.loaded).toBe(true);
            expect(assets.textures.size).toBe(1);
            expect(assets.prefabs.size).toBe(1);
        });

        test('multiple items in both buckets', async () => {
            const assets = new AssetBucket('3d')
                .textures(({ bucket }) => bucket
                    .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG })
                    .add({ type: 'texture', id: 'b', src: RED_PIXEL_PNG })
                )
                .prefabs(({ bucket }) => bucket
                    .add({ type: 'cube', id: 'x', size: 1 })
                    .add({ type: 'cube', id: 'y', size: 2 })
                    .add({ type: 'grid', id: 'z', size: 5, step: 1, lineWidth: 0.01 })
                );

            await assets.load();

            expect(assets.textures.size).toBe(2);
            expect(assets.prefabs.size).toBe(3);

            const texIds = assets.textures.entries().map(t => t.id).sort();
            expect(texIds).toEqual(['a', 'b']);

            const prefabIds = assets.prefabs.entries().map(p => p.id).sort();
            expect(prefabIds).toEqual(['x', 'y', 'z']);
        });
    });

    describe('2D mode', () => {
        test('constructs in 2d mode', () => {
            const assets = new AssetBucket('2d');
            expect(assets.textures).toBeDefined();
            expect(assets.prefabs).toBeDefined();
        });

        test('loads textures', async () => {
            const assets = new AssetBucket('2d')
                .textures(({ bucket }) => bucket
                    .add({ type: 'texture', id: 'bg', src: RED_PIXEL_PNG })
                );

            await assets.load();

            const tex = assets.textures.get('bg');
            expect(tex.type).toBe('texture');
        });
    });
});

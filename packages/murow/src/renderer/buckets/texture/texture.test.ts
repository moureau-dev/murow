import { test, expect, describe, beforeAll } from 'bun:test';
import { TextureBucket } from './texture';

// Bun's test runner doesn't have a global Image constructor.
// Provide a minimal mock that satisfies the texture parser.
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

// 1×1 red pixel PNG (valid minimal PNG)
const RED_PIXEL_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

describe('TextureBucket', () => {
    test('starts empty', () => {
        const bucket = new TextureBucket();
        expect(bucket.loaded).toBe(false);
        expect(bucket.size).toBe(0);
    });

    test('add() chains and accumulates', () => {
        const bucket = new TextureBucket()
            .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG })
            .add({ type: 'texture', id: 'b', src: RED_PIXEL_PNG });
        expect(bucket.size).toBe(2);
    });

    test('load() parses image textures', async () => {
        const bucket = new TextureBucket()
            .add({ type: 'texture', id: 'tile', src: RED_PIXEL_PNG });

        await bucket.load();

        expect(bucket.loaded).toBe(true);

        const tex = bucket.get('tile');
        expect(tex.type).toBe('texture');
        expect(tex.id).toBe('tile');
        expect(tex.src).toBe(RED_PIXEL_PNG);
        expect(tex.parsed).toBeDefined();
        expect(tex.parsed.naturalWidth).toBe(1);
        expect(tex.parsed.naturalHeight).toBe(1);
    });

    test('load() is idempotent', async () => {
        const bucket = new TextureBucket()
            .add({ type: 'texture', id: 'x', src: RED_PIXEL_PNG });
        await bucket.load();
        await bucket.load();
        expect(bucket.loaded).toBe(true);
        expect(bucket.size).toBe(1);
    });

    test('entries() returns all parsed textures', async () => {
        const bucket = new TextureBucket()
            .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG })
            .add({ type: 'texture', id: 'b', src: RED_PIXEL_PNG });

        await bucket.load();
        const ids = bucket.entries().map(t => t.id);
        expect(ids).toEqual(['a', 'b']);
    });

    test('metadata is passed through', async () => {
        const bucket = new TextureBucket()
            .add({ type: 'texture', id: 'm', src: RED_PIXEL_PNG, metadata: { repeat: true } });

        await bucket.load();
        const tex = bucket.get('m');
        expect(tex.metadata).toEqual({ repeat: true });
    });

    describe('errors', () => {
        test('duplicate id throws', () => {
            const bucket = new TextureBucket()
                .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG });
            expect(() => bucket.add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG }))
                .toThrow(/duplicate id 'a'/);
        });

        test('get() before load throws', () => {
            const bucket = new TextureBucket()
                .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG });
            expect(() => bucket.get('a' as never)).toThrow(/before load/);
        });

        test('get() with unknown id throws', async () => {
            const bucket = new TextureBucket()
                .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG });
            await bucket.load();
            expect(() => bucket.get('missing' as never)).toThrow(/unknown prefab id 'missing'/);
        });

        test('add() after load throws', async () => {
            const bucket = new TextureBucket()
                .add({ type: 'texture', id: 'a', src: RED_PIXEL_PNG });
            await bucket.load();
            expect(() => bucket.add({ type: 'texture', id: 'b', src: RED_PIXEL_PNG }))
                .toThrow(/frozen/);
        });

        test('entries() before load throws', () => {
            const bucket = new TextureBucket();
            expect(() => bucket.entries()).toThrow(/before load/);
        });
    });
});

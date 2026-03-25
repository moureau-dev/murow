import { test, expect, describe } from 'bun:test';
import { computeGridUVs, computeTexturePackerUVs } from './spritesheet';
import type { TexturePackerData } from './spritesheet';

describe('computeGridUVs', () => {
    test('single frame spanning entire image', () => {
        const uvs = computeGridUVs(64, 64, 64, 64);
        expect(uvs.length).toBe(1);
        expect(uvs[0]).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
    });

    test('2x2 grid', () => {
        const uvs = computeGridUVs(128, 128, 64, 64);
        expect(uvs.length).toBe(4);

        // Row 0, Col 0
        expect(uvs[0].minX).toBeCloseTo(0);
        expect(uvs[0].minY).toBeCloseTo(0);
        expect(uvs[0].maxX).toBeCloseTo(0.5);
        expect(uvs[0].maxY).toBeCloseTo(0.5);

        // Row 0, Col 1
        expect(uvs[1].minX).toBeCloseTo(0.5);
        expect(uvs[1].minY).toBeCloseTo(0);
        expect(uvs[1].maxX).toBeCloseTo(1);
        expect(uvs[1].maxY).toBeCloseTo(0.5);

        // Row 1, Col 0
        expect(uvs[2].minX).toBeCloseTo(0);
        expect(uvs[2].minY).toBeCloseTo(0.5);
        expect(uvs[2].maxX).toBeCloseTo(0.5);
        expect(uvs[2].maxY).toBeCloseTo(1);

        // Row 1, Col 1
        expect(uvs[3].minX).toBeCloseTo(0.5);
        expect(uvs[3].minY).toBeCloseTo(0.5);
        expect(uvs[3].maxX).toBeCloseTo(1);
        expect(uvs[3].maxY).toBeCloseTo(1);
    });

    test('4x2 grid (4 columns, 2 rows)', () => {
        const uvs = computeGridUVs(256, 128, 64, 64);
        expect(uvs.length).toBe(8);
    });

    test('non-square frames', () => {
        const uvs = computeGridUVs(200, 100, 100, 50);
        expect(uvs.length).toBe(4); // 2 cols * 2 rows

        expect(uvs[0].minX).toBeCloseTo(0);
        expect(uvs[0].maxX).toBeCloseTo(0.5);
        expect(uvs[0].minY).toBeCloseTo(0);
        expect(uvs[0].maxY).toBeCloseTo(0.5);
    });

    test('frames do not exceed image bounds', () => {
        // Image is 100x100, frame is 30x30 => 3 cols, 3 rows = 9 frames
        // (remaining 10px on each axis is wasted)
        const uvs = computeGridUVs(100, 100, 30, 30);
        expect(uvs.length).toBe(9);

        for (const uv of uvs) {
            expect(uv.minX).toBeGreaterThanOrEqual(0);
            expect(uv.minY).toBeGreaterThanOrEqual(0);
            expect(uv.maxX).toBeLessThanOrEqual(1);
            expect(uv.maxY).toBeLessThanOrEqual(1);
            expect(uv.maxX).toBeGreaterThan(uv.minX);
            expect(uv.maxY).toBeGreaterThan(uv.minY);
        }
    });

    test('row-major order: row 0 frames come before row 1', () => {
        const uvs = computeGridUVs(128, 128, 64, 64);
        // uvs[0] and uvs[1] are row 0, uvs[2] and uvs[3] are row 1
        expect(uvs[0].minY).toBeLessThan(uvs[2].minY);
        expect(uvs[1].minY).toBeLessThan(uvs[3].minY);
    });

    test('zero frames when frame larger than image', () => {
        const uvs = computeGridUVs(32, 32, 64, 64);
        expect(uvs.length).toBe(0);
    });

    test('single column', () => {
        const uvs = computeGridUVs(64, 256, 64, 64);
        expect(uvs.length).toBe(4);
        for (const uv of uvs) {
            expect(uv.minX).toBe(0);
            expect(uv.maxX).toBe(1);
        }
    });

    test('single row', () => {
        const uvs = computeGridUVs(256, 64, 64, 64);
        expect(uvs.length).toBe(4);
        for (const uv of uvs) {
            expect(uv.minY).toBe(0);
            expect(uv.maxY).toBe(1);
        }
    });

    test('UV width equals frameWidth / imageWidth', () => {
        const uvs = computeGridUVs(512, 256, 128, 64);
        for (const uv of uvs) {
            expect(uv.maxX - uv.minX).toBeCloseTo(128 / 512);
            expect(uv.maxY - uv.minY).toBeCloseTo(64 / 256);
        }
    });
});

describe('computeTexturePackerUVs', () => {
    test('single frame', () => {
        const data: TexturePackerData = {
            frames: {
                'sprite_0': { frame: { x: 0, y: 0, w: 32, h: 32 } },
            },
            meta: { size: { w: 64, h: 64 } },
        };
        const uvs = computeTexturePackerUVs(data);
        expect(uvs.length).toBe(1);
        expect(uvs[0]).toEqual({
            minX: 0,
            minY: 0,
            maxX: 0.5,
            maxY: 0.5,
        });
    });

    test('multiple frames', () => {
        const data: TexturePackerData = {
            frames: {
                'idle_0': { frame: { x: 0, y: 0, w: 64, h: 64 } },
                'idle_1': { frame: { x: 64, y: 0, w: 64, h: 64 } },
                'idle_2': { frame: { x: 0, y: 64, w: 64, h: 64 } },
            },
            meta: { size: { w: 128, h: 128 } },
        };
        const uvs = computeTexturePackerUVs(data);
        expect(uvs.length).toBe(3);

        expect(uvs[0]).toEqual({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 });
        expect(uvs[1]).toEqual({ minX: 0.5, minY: 0, maxX: 1, maxY: 0.5 });
        expect(uvs[2]).toEqual({ minX: 0, minY: 0.5, maxX: 0.5, maxY: 1 });
    });

    test('non-uniform frame sizes', () => {
        const data: TexturePackerData = {
            frames: {
                'small': { frame: { x: 0, y: 0, w: 16, h: 16 } },
                'big': { frame: { x: 16, y: 0, w: 48, h: 32 } },
            },
            meta: { size: { w: 64, h: 32 } },
        };
        const uvs = computeTexturePackerUVs(data);
        expect(uvs.length).toBe(2);

        expect(uvs[0].minX).toBeCloseTo(0);
        expect(uvs[0].maxX).toBeCloseTo(0.25);
        expect(uvs[0].minY).toBeCloseTo(0);
        expect(uvs[0].maxY).toBeCloseTo(0.5);

        expect(uvs[1].minX).toBeCloseTo(0.25);
        expect(uvs[1].maxX).toBeCloseTo(1);
        expect(uvs[1].minY).toBeCloseTo(0);
        expect(uvs[1].maxY).toBeCloseTo(1);
    });

    test('empty frames object', () => {
        const data: TexturePackerData = {
            frames: {},
            meta: { size: { w: 64, h: 64 } },
        };
        const uvs = computeTexturePackerUVs(data);
        expect(uvs.length).toBe(0);
    });

    test('all UVs are in [0, 1] range', () => {
        const data: TexturePackerData = {
            frames: {
                'a': { frame: { x: 10, y: 20, w: 30, h: 40 } },
                'b': { frame: { x: 50, y: 60, w: 50, h: 40 } },
            },
            meta: { size: { w: 100, h: 100 } },
        };
        const uvs = computeTexturePackerUVs(data);
        for (const uv of uvs) {
            expect(uv.minX).toBeGreaterThanOrEqual(0);
            expect(uv.minX).toBeLessThanOrEqual(1);
            expect(uv.minY).toBeGreaterThanOrEqual(0);
            expect(uv.minY).toBeLessThanOrEqual(1);
            expect(uv.maxX).toBeGreaterThanOrEqual(0);
            expect(uv.maxX).toBeLessThanOrEqual(1);
            expect(uv.maxY).toBeGreaterThanOrEqual(0);
            expect(uv.maxY).toBeLessThanOrEqual(1);
        }
    });

    test('frame at image edge', () => {
        const data: TexturePackerData = {
            frames: {
                'edge': { frame: { x: 32, y: 32, w: 32, h: 32 } },
            },
            meta: { size: { w: 64, h: 64 } },
        };
        const uvs = computeTexturePackerUVs(data);
        expect(uvs[0]).toEqual({ minX: 0.5, minY: 0.5, maxX: 1, maxY: 1 });
    });

    test('preserves order of Object.keys', () => {
        const data: TexturePackerData = {
            frames: {
                'z_last': { frame: { x: 0, y: 0, w: 10, h: 10 } },
                'a_first': { frame: { x: 10, y: 0, w: 10, h: 10 } },
                'm_middle': { frame: { x: 20, y: 0, w: 10, h: 10 } },
            },
            meta: { size: { w: 30, h: 10 } },
        };
        const uvs = computeTexturePackerUVs(data);
        expect(uvs.length).toBe(3);
        // First entry should correspond to 'z_last' (insertion order)
        expect(uvs[0].minX).toBeCloseTo(0);
        expect(uvs[1].minX).toBeCloseTo(10 / 30);
        expect(uvs[2].minX).toBeCloseTo(20 / 30);
    });
});

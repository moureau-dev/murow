import { describe, expect, test } from 'bun:test';
import { Std140, Std430, alignUp, structLayout } from './align';
import { f32, vec2f, vec3f } from './primitives';

describe('alignUp', () => {
    test('rounds up to the next multiple', () => {
        expect(alignUp(0, 16)).toBe(0);
        expect(alignUp(1, 16)).toBe(16);
        expect(alignUp(12, 4)).toBe(12);
        expect(alignUp(13, 4)).toBe(16);
        expect(alignUp(17, 16)).toBe(32);
    });
});

describe('structLayout', () => {
    test('places fields by their alignment under std140', () => {
        const layout = structLayout([
            { name: 'a', field: f32 },
            { name: 'b', field: vec3f },
            { name: 'c', field: f32 },
        ]);
        expect(layout.fields.map((f) => f.offset)).toEqual([0, 16, 28]);
        expect(layout.align).toBe(16);
        expect(layout.size).toBe(32);
        expect(layout.packing).toBe(Std140);
    });

    test('vec3 array-style padding follows field size', () => {
        const layout = structLayout([
            { name: 'a', field: vec3f },
            { name: 'b', field: f32 },
        ]);
        expect(layout.fields[1].offset).toBe(12);
        expect(layout.size).toBe(16);
    });

    test('std140 rounds small structs to 16 bytes', () => {
        const layout = structLayout([
            { name: 'a', field: f32 },
            { name: 'b', field: f32 },
        ]);
        expect(layout.size).toBe(16);
    });

    test('std430 packs tighter', () => {
        const layout = structLayout(
            [
                { name: 'a', field: f32 },
                { name: 'b', field: f32 },
            ],
            Std430,
        );
        expect(layout.align).toBe(4);
        expect(layout.size).toBe(8);
        expect(layout.packing).toBe(Std430);
    });

    test('vec2 only struct aligns to 16 under std140', () => {
        const layout = structLayout([{ name: 'v', field: vec2f }]);
        expect(layout.align).toBe(16);
        expect(layout.size).toBe(16);
    });
});

import { test, expect, describe } from 'bun:test';
import {
    computeTightOffsets,
    formatSize,
    tightStride,
    VertexBufferLayout,
    VertexLayoutBuilder,
} from './vertex-layout';

describe('vertex format helpers', () => {
    test('reports sizes for known formats', () => {
        expect(formatSize('float32x3')).toBe(12);
        expect(formatSize('unorm8x4')).toBe(4);
        expect(formatSize('unorm10-10-10-2')).toBe(4);
    });

    test('throws for an unknown format', () => {
        expect(() => formatSize('nope')).toThrow();
    });

    test('computes tight offsets and stride', () => {
        const formats = ['float32x3', 'float32x2', 'uint8x4'] as const;
        expect(computeTightOffsets(formats)).toEqual([0, 12, 20]);
        expect(tightStride(formats)).toBe(24);
    });
});

describe('VertexBufferLayout', () => {
    test('derives a tight stride when none is given', () => {
        const layout = new VertexBufferLayout({
            attributes: [
                { location: 0, format: 'float32x3', offset: 0 },
                { location: 1, format: 'float32x2', offset: 12 },
            ],
        });
        expect(layout.stride).toBe(20);
        expect(layout.stepMode).toBe('vertex');
    });

    test('accepts an explicit stride', () => {
        const layout = new VertexBufferLayout({
            stride: 32,
            stepMode: 'instance',
            attributes: [{ location: 0, format: 'float32x4', offset: 0 }],
        });
        expect(layout.stride).toBe(32);
        expect(layout.stepMode).toBe('instance');
    });

    test('throws on duplicate locations', () => {
        expect(
            () =>
                new VertexBufferLayout({
                    attributes: [
                        { location: 0, format: 'float32', offset: 0 },
                        { location: 0, format: 'float32', offset: 4 },
                    ],
                }),
        ).toThrow();
    });

    test('throws when an attribute overruns the stride', () => {
        expect(
            () =>
                new VertexBufferLayout({
                    stride: 8,
                    attributes: [{ location: 0, format: 'float32x3', offset: 0 }],
                }),
        ).toThrow();
    });
});

describe('VertexLayoutBuilder', () => {
    test('packs attributes with tight offsets and sequential locations', () => {
        const layout = new VertexLayoutBuilder()
            .attribute('float32x3')
            .attribute('float32x2')
            .stepMode('instance')
            .build();
        expect(layout.attributes).toEqual([
            { location: 0, format: 'float32x3', offset: 0 },
            { location: 1, format: 'float32x2', offset: 12 },
        ]);
        expect(layout.stride).toBe(20);
        expect(layout.stepMode).toBe('instance');
    });

    test('honours a starting location and explicit stride', () => {
        const layout = new VertexLayoutBuilder().startingLocation(3).attribute('float32').stride(16).build();
        expect(layout.attributes[0].location).toBe(3);
        expect(layout.stride).toBe(16);
    });
});

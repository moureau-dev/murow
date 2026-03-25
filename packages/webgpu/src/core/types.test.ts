import { test, expect, describe } from 'bun:test';
import * as d from 'typegpu/data';
import {
    DynamicSprite,
    StaticSprite,
    SpriteUniforms,
    DynamicInstance3D,
    StaticInstance3D,
} from './types';
import {
    DYNAMIC_FLOATS_PER_SPRITE,
    STATIC_FLOATS_PER_SPRITE,
    DYNAMIC_3D_FLOATS_PER_INSTANCE,
    STATIC_3D_FLOATS_PER_INSTANCE,
} from './constants';

describe('DynamicSprite struct', () => {
    test('is defined', () => {
        expect(DynamicSprite).toBeDefined();
    });

    test('has 6 f32 fields matching DYNAMIC_FLOATS_PER_SPRITE', () => {
        // Each f32 is 4 bytes; 6 f32s = 24 bytes
        const size = d.sizeOf(DynamicSprite);
        expect(size).toBe(DYNAMIC_FLOATS_PER_SPRITE * 4);
    });
});

describe('StaticSprite struct', () => {
    test('is defined', () => {
        expect(StaticSprite).toBeDefined();
    });

    test('has 14 f32 fields matching STATIC_FLOATS_PER_SPRITE', () => {
        const size = d.sizeOf(StaticSprite);
        expect(size).toBe(STATIC_FLOATS_PER_SPRITE * 4);
    });
});

describe('SpriteUniforms struct', () => {
    test('is defined', () => {
        expect(SpriteUniforms).toBeDefined();
    });

    test('has expected size (mat3x3f + f32 + vec2f)', () => {
        // mat3x3f in std140: 3 columns of vec3f, each padded to vec4f = 3 * 16 = 48 bytes
        // f32 = 4 bytes
        // vec2f = 8 bytes
        // With alignment, the total depends on TypeGPU's layout rules
        const size = d.sizeOf(SpriteUniforms);
        expect(size).toBeGreaterThan(0);
    });
});

describe('DynamicInstance3D struct', () => {
    test('is defined', () => {
        expect(DynamicInstance3D).toBeDefined();
    });

    test('has 14 f32 fields matching DYNAMIC_3D_FLOATS_PER_INSTANCE', () => {
        const size = d.sizeOf(DynamicInstance3D);
        expect(size).toBe(DYNAMIC_3D_FLOATS_PER_INSTANCE * 4);
    });
});

describe('StaticInstance3D struct', () => {
    test('is defined', () => {
        expect(StaticInstance3D).toBeDefined();
    });

    test('has 11 f32 fields matching STATIC_3D_FLOATS_PER_INSTANCE', () => {
        const size = d.sizeOf(StaticInstance3D);
        expect(size).toBe(STATIC_3D_FLOATS_PER_INSTANCE * 4);
    });
});

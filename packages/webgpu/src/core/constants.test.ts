import { test, expect, describe } from 'bun:test';
import {
    DYNAMIC_OFFSET_PREV_X,
    DYNAMIC_OFFSET_PREV_Y,
    DYNAMIC_OFFSET_CURR_X,
    DYNAMIC_OFFSET_CURR_Y,
    DYNAMIC_OFFSET_PREV_ROTATION,
    DYNAMIC_OFFSET_CURR_ROTATION,
    DYNAMIC_FLOATS_PER_SPRITE,
    STATIC_OFFSET_SCALE_X,
    STATIC_OFFSET_SCALE_Y,
    STATIC_OFFSET_UV_MIN_X,
    STATIC_OFFSET_UV_MIN_Y,
    STATIC_OFFSET_UV_MAX_X,
    STATIC_OFFSET_UV_MAX_Y,
    STATIC_OFFSET_LAYER,
    STATIC_OFFSET_FLIP_X,
    STATIC_OFFSET_FLIP_Y,
    STATIC_OFFSET_OPACITY,
    STATIC_OFFSET_TINT_R,
    STATIC_OFFSET_TINT_G,
    STATIC_OFFSET_TINT_B,
    STATIC_OFFSET_TINT_A,
    STATIC_FLOATS_PER_SPRITE,
    DYNAMIC_3D_OFFSET_PREV_POS_X,
    DYNAMIC_3D_OFFSET_PREV_POS_Y,
    DYNAMIC_3D_OFFSET_PREV_POS_Z,
    DYNAMIC_3D_OFFSET_CURR_POS_X,
    DYNAMIC_3D_OFFSET_CURR_POS_Y,
    DYNAMIC_3D_OFFSET_CURR_POS_Z,
    DYNAMIC_3D_OFFSET_PREV_ROT_X,
    DYNAMIC_3D_OFFSET_PREV_ROT_Y,
    DYNAMIC_3D_OFFSET_PREV_ROT_Z,
    DYNAMIC_3D_OFFSET_PREV_ROT_W,
    DYNAMIC_3D_OFFSET_CURR_ROT_X,
    DYNAMIC_3D_OFFSET_CURR_ROT_Y,
    DYNAMIC_3D_OFFSET_CURR_ROT_Z,
    DYNAMIC_3D_OFFSET_CURR_ROT_W,
    DYNAMIC_3D_FLOATS_PER_INSTANCE,
    STATIC_3D_OFFSET_SCALE_X,
    STATIC_3D_OFFSET_SCALE_Y,
    STATIC_3D_OFFSET_SCALE_Z,
    STATIC_3D_OFFSET_MATERIAL_ID,
    STATIC_3D_OFFSET_OPACITY,
    STATIC_3D_OFFSET_TINT_R,
    STATIC_3D_OFFSET_TINT_G,
    STATIC_3D_OFFSET_TINT_B,
    STATIC_3D_OFFSET_TINT_A,
    STATIC_3D_OFFSET_CUSTOM_0,
    STATIC_3D_OFFSET_CUSTOM_1,
    STATIC_3D_FLOATS_PER_INSTANCE,
    INVALID_INDEX,
    INVALID_ENTITY,
} from './constants';

describe('2D Dynamic layout', () => {
    test('offsets are sequential starting from 0', () => {
        expect(DYNAMIC_OFFSET_PREV_X).toBe(0);
        expect(DYNAMIC_OFFSET_PREV_Y).toBe(1);
        expect(DYNAMIC_OFFSET_CURR_X).toBe(2);
        expect(DYNAMIC_OFFSET_CURR_Y).toBe(3);
        expect(DYNAMIC_OFFSET_PREV_ROTATION).toBe(4);
        expect(DYNAMIC_OFFSET_CURR_ROTATION).toBe(5);
    });

    test('stride matches last offset + 1', () => {
        expect(DYNAMIC_FLOATS_PER_SPRITE).toBe(6);
        expect(DYNAMIC_FLOATS_PER_SPRITE).toBe(DYNAMIC_OFFSET_CURR_ROTATION + 1);
    });

    test('all offsets are less than stride', () => {
        const offsets = [
            DYNAMIC_OFFSET_PREV_X, DYNAMIC_OFFSET_PREV_Y,
            DYNAMIC_OFFSET_CURR_X, DYNAMIC_OFFSET_CURR_Y,
            DYNAMIC_OFFSET_PREV_ROTATION, DYNAMIC_OFFSET_CURR_ROTATION,
        ];
        for (const offset of offsets) {
            expect(offset).toBeLessThan(DYNAMIC_FLOATS_PER_SPRITE);
        }
    });

    test('no duplicate offsets', () => {
        const offsets = [
            DYNAMIC_OFFSET_PREV_X, DYNAMIC_OFFSET_PREV_Y,
            DYNAMIC_OFFSET_CURR_X, DYNAMIC_OFFSET_CURR_Y,
            DYNAMIC_OFFSET_PREV_ROTATION, DYNAMIC_OFFSET_CURR_ROTATION,
        ];
        expect(new Set(offsets).size).toBe(offsets.length);
    });
});

describe('2D Static layout', () => {
    test('offsets are sequential starting from 0', () => {
        expect(STATIC_OFFSET_SCALE_X).toBe(0);
        expect(STATIC_OFFSET_SCALE_Y).toBe(1);
        expect(STATIC_OFFSET_UV_MIN_X).toBe(2);
        expect(STATIC_OFFSET_UV_MIN_Y).toBe(3);
        expect(STATIC_OFFSET_UV_MAX_X).toBe(4);
        expect(STATIC_OFFSET_UV_MAX_Y).toBe(5);
        expect(STATIC_OFFSET_LAYER).toBe(6);
        expect(STATIC_OFFSET_FLIP_X).toBe(7);
        expect(STATIC_OFFSET_FLIP_Y).toBe(8);
        expect(STATIC_OFFSET_OPACITY).toBe(9);
        expect(STATIC_OFFSET_TINT_R).toBe(10);
        expect(STATIC_OFFSET_TINT_G).toBe(11);
        expect(STATIC_OFFSET_TINT_B).toBe(12);
        expect(STATIC_OFFSET_TINT_A).toBe(13);
    });

    test('stride matches field count', () => {
        expect(STATIC_FLOATS_PER_SPRITE).toBe(14);
        expect(STATIC_FLOATS_PER_SPRITE).toBe(STATIC_OFFSET_TINT_A + 1);
    });

    test('no duplicate offsets', () => {
        const offsets = [
            STATIC_OFFSET_SCALE_X, STATIC_OFFSET_SCALE_Y,
            STATIC_OFFSET_UV_MIN_X, STATIC_OFFSET_UV_MIN_Y,
            STATIC_OFFSET_UV_MAX_X, STATIC_OFFSET_UV_MAX_Y,
            STATIC_OFFSET_LAYER, STATIC_OFFSET_FLIP_X, STATIC_OFFSET_FLIP_Y,
            STATIC_OFFSET_OPACITY,
            STATIC_OFFSET_TINT_R, STATIC_OFFSET_TINT_G, STATIC_OFFSET_TINT_B, STATIC_OFFSET_TINT_A,
        ];
        expect(new Set(offsets).size).toBe(offsets.length);
    });
});

describe('3D Dynamic layout', () => {
    test('offsets are sequential starting from 0', () => {
        expect(DYNAMIC_3D_OFFSET_PREV_POS_X).toBe(0);
        expect(DYNAMIC_3D_OFFSET_PREV_POS_Y).toBe(1);
        expect(DYNAMIC_3D_OFFSET_PREV_POS_Z).toBe(2);
        expect(DYNAMIC_3D_OFFSET_CURR_POS_X).toBe(3);
        expect(DYNAMIC_3D_OFFSET_CURR_POS_Y).toBe(4);
        expect(DYNAMIC_3D_OFFSET_CURR_POS_Z).toBe(5);
        expect(DYNAMIC_3D_OFFSET_PREV_ROT_X).toBe(6);
        expect(DYNAMIC_3D_OFFSET_PREV_ROT_Y).toBe(7);
        expect(DYNAMIC_3D_OFFSET_PREV_ROT_Z).toBe(8);
        expect(DYNAMIC_3D_OFFSET_PREV_ROT_W).toBe(9);
        expect(DYNAMIC_3D_OFFSET_CURR_ROT_X).toBe(10);
        expect(DYNAMIC_3D_OFFSET_CURR_ROT_Y).toBe(11);
        expect(DYNAMIC_3D_OFFSET_CURR_ROT_Z).toBe(12);
        expect(DYNAMIC_3D_OFFSET_CURR_ROT_W).toBe(13);
    });

    test('stride matches field count', () => {
        expect(DYNAMIC_3D_FLOATS_PER_INSTANCE).toBe(14);
        expect(DYNAMIC_3D_FLOATS_PER_INSTANCE).toBe(DYNAMIC_3D_OFFSET_CURR_ROT_W + 1);
    });

    test('position fields come before rotation fields', () => {
        expect(DYNAMIC_3D_OFFSET_CURR_POS_Z).toBeLessThan(DYNAMIC_3D_OFFSET_PREV_ROT_X);
    });
});

describe('3D Static layout', () => {
    test('offsets are sequential starting from 0', () => {
        expect(STATIC_3D_OFFSET_SCALE_X).toBe(0);
        expect(STATIC_3D_OFFSET_SCALE_Y).toBe(1);
        expect(STATIC_3D_OFFSET_SCALE_Z).toBe(2);
        expect(STATIC_3D_OFFSET_MATERIAL_ID).toBe(3);
        expect(STATIC_3D_OFFSET_OPACITY).toBe(4);
        expect(STATIC_3D_OFFSET_TINT_R).toBe(5);
        expect(STATIC_3D_OFFSET_TINT_G).toBe(6);
        expect(STATIC_3D_OFFSET_TINT_B).toBe(7);
        expect(STATIC_3D_OFFSET_TINT_A).toBe(8);
        expect(STATIC_3D_OFFSET_CUSTOM_0).toBe(9);
        expect(STATIC_3D_OFFSET_CUSTOM_1).toBe(10);
    });

    test('stride matches field count', () => {
        expect(STATIC_3D_FLOATS_PER_INSTANCE).toBe(11);
        expect(STATIC_3D_FLOATS_PER_INSTANCE).toBe(STATIC_3D_OFFSET_CUSTOM_1 + 1);
    });
});

describe('Sentinel values', () => {
    test('INVALID_INDEX is 0xFFFFFFFF', () => {
        expect(INVALID_INDEX).toBe(0xFFFFFFFF);
    });

    test('INVALID_ENTITY is 0xFFFFFFFF', () => {
        expect(INVALID_ENTITY).toBe(0xFFFFFFFF);
    });

    test('sentinel values are the same', () => {
        expect(INVALID_INDEX).toBe(INVALID_ENTITY);
    });
});

import { test, expect, describe } from 'bun:test';
import { SpriteAccessor } from './sprite-accessor';
import {
    DYNAMIC_FLOATS_PER_SPRITE,
    STATIC_FLOATS_PER_SPRITE,
    DYNAMIC_OFFSET_CURR_X,
    DYNAMIC_OFFSET_CURR_Y,
    DYNAMIC_OFFSET_PREV_X,
    DYNAMIC_OFFSET_PREV_Y,
    DYNAMIC_OFFSET_CURR_ROTATION,
    DYNAMIC_OFFSET_PREV_ROTATION,
    STATIC_OFFSET_SCALE_X,
    STATIC_OFFSET_SCALE_Y,
    STATIC_OFFSET_LAYER,
    STATIC_OFFSET_FLIP_X,
    STATIC_OFFSET_FLIP_Y,
    STATIC_OFFSET_OPACITY,
    STATIC_OFFSET_TINT_R,
    STATIC_OFFSET_TINT_G,
    STATIC_OFFSET_TINT_B,
    STATIC_OFFSET_TINT_A,
    STATIC_OFFSET_UV_MIN_X,
    STATIC_OFFSET_UV_MIN_Y,
    STATIC_OFFSET_UV_MAX_X,
    STATIC_OFFSET_UV_MAX_Y,
} from '../core/constants';

function createAccessor(slot = 0, sheetId = 0) {
    const dynamicData = new Float32Array(DYNAMIC_FLOATS_PER_SPRITE * 4);
    const staticData = new Float32Array(STATIC_FLOATS_PER_SPRITE * 4);
    let dirtyCount = 0;
    const onDirty = () => { dirtyCount++; };
    const accessor = new SpriteAccessor(dynamicData, staticData, slot, sheetId, onDirty);
    return { accessor, dynamicData, staticData, getDirtyCount: () => dirtyCount };
}

describe('SpriteAccessor', () => {
    describe('slot and sheetId', () => {
        test('returns correct slot', () => {
            const { accessor } = createAccessor(3, 7);
            expect(accessor.slot).toBe(3);
        });

        test('returns correct sheetId', () => {
            const { accessor } = createAccessor(3, 7);
            expect(accessor.sheetId).toBe(7);
        });
    });

    describe('dynamic properties: x, y', () => {
        test('get/set x', () => {
            const { accessor } = createAccessor();
            expect(accessor.x).toBe(0);
            accessor.x = 42.5;
            expect(accessor.x).toBe(42.5);
        });

        test('get/set y', () => {
            const { accessor } = createAccessor();
            accessor.y = -10;
            expect(accessor.y).toBe(-10);
        });

        test('x and y write to correct dynamic buffer offsets', () => {
            const { accessor, dynamicData } = createAccessor(0);
            accessor.x = 100;
            accessor.y = 200;
            expect(dynamicData[DYNAMIC_OFFSET_CURR_X]).toBe(100);
            expect(dynamicData[DYNAMIC_OFFSET_CURR_Y]).toBe(200);
        });

        test('slot offset is applied correctly', () => {
            const { accessor, dynamicData } = createAccessor(2);
            accessor.x = 50;
            accessor.y = 60;
            const base = 2 * DYNAMIC_FLOATS_PER_SPRITE;
            expect(dynamicData[base + DYNAMIC_OFFSET_CURR_X]).toBe(50);
            expect(dynamicData[base + DYNAMIC_OFFSET_CURR_Y]).toBe(60);
        });
    });

    describe('dynamic properties: rotation', () => {
        test('get/set rotation', () => {
            const { accessor } = createAccessor();
            accessor.rotation = Math.PI;
            expect(accessor.rotation).toBeCloseTo(Math.PI);
        });
    });

    describe('prevX, prevY, prevRotation (read-only)', () => {
        test('prevX and prevY default to 0', () => {
            const { accessor } = createAccessor();
            expect(accessor.prevX).toBe(0);
            expect(accessor.prevY).toBe(0);
        });

        test('prevRotation defaults to 0', () => {
            const { accessor } = createAccessor();
            expect(accessor.prevRotation).toBe(0);
        });
    });

    describe('storePrevious', () => {
        test('copies current x, y, rotation to prev', () => {
            const { accessor } = createAccessor();
            accessor.x = 10;
            accessor.y = 20;
            accessor.rotation = 1.5;

            accessor.storePrevious();

            expect(accessor.prevX).toBe(10);
            expect(accessor.prevY).toBe(20);
            expect(accessor.prevRotation).toBe(1.5);
        });

        test('storePrevious then update current: prev stays old', () => {
            const { accessor } = createAccessor();
            accessor.x = 100;
            accessor.y = 200;
            accessor.storePrevious();

            accessor.x = 150;
            accessor.y = 250;

            expect(accessor.prevX).toBe(100);
            expect(accessor.prevY).toBe(200);
            expect(accessor.x).toBe(150);
            expect(accessor.y).toBe(250);
        });

        test('multiple storePrevious calls overwrite prev correctly', () => {
            const { accessor } = createAccessor();
            accessor.x = 1;
            accessor.storePrevious();
            expect(accessor.prevX).toBe(1);

            accessor.x = 2;
            accessor.storePrevious();
            expect(accessor.prevX).toBe(2);
        });
    });

    describe('static properties: scaleX, scaleY', () => {
        test('get/set scaleX', () => {
            const { accessor } = createAccessor();
            accessor.scaleX = 2.5;
            expect(accessor.scaleX).toBe(2.5);
        });

        test('get/set scaleY', () => {
            const { accessor } = createAccessor();
            accessor.scaleY = 0.5;
            expect(accessor.scaleY).toBe(0.5);
        });

        test('scaleX triggers dirty callback', () => {
            const { accessor, getDirtyCount } = createAccessor();
            accessor.scaleX = 1;
            expect(getDirtyCount()).toBe(1);
        });

        test('scaleY triggers dirty callback', () => {
            const { accessor, getDirtyCount } = createAccessor();
            accessor.scaleY = 1;
            expect(getDirtyCount()).toBe(1);
        });
    });

    describe('static properties: layer', () => {
        test('get/set layer', () => {
            const { accessor } = createAccessor();
            accessor.layer = 5;
            expect(accessor.layer).toBe(5);
        });

        test('layer triggers dirty callback', () => {
            const { accessor, getDirtyCount } = createAccessor();
            accessor.layer = 3;
            expect(getDirtyCount()).toBe(1);
        });
    });

    describe('static properties: flipX, flipY', () => {
        test('flipX defaults to false', () => {
            const { accessor } = createAccessor();
            expect(accessor.flipX).toBe(false);
        });

        test('set flipX to true', () => {
            const { accessor } = createAccessor();
            accessor.flipX = true;
            expect(accessor.flipX).toBe(true);
        });

        test('set flipX to false after true', () => {
            const { accessor } = createAccessor();
            accessor.flipX = true;
            accessor.flipX = false;
            expect(accessor.flipX).toBe(false);
        });

        test('flipY defaults to false', () => {
            const { accessor } = createAccessor();
            expect(accessor.flipY).toBe(false);
        });

        test('set flipY to true', () => {
            const { accessor } = createAccessor();
            accessor.flipY = true;
            expect(accessor.flipY).toBe(true);
        });

        test('flipX writes 1/0 to static buffer', () => {
            const { accessor, staticData } = createAccessor();
            accessor.flipX = true;
            expect(staticData[STATIC_OFFSET_FLIP_X]).toBe(1);
            accessor.flipX = false;
            expect(staticData[STATIC_OFFSET_FLIP_X]).toBe(0);
        });

        test('flip triggers dirty callback', () => {
            const { accessor, getDirtyCount } = createAccessor();
            accessor.flipX = true;
            accessor.flipY = true;
            expect(getDirtyCount()).toBe(2);
        });
    });

    describe('static properties: opacity', () => {
        test('get/set opacity', () => {
            const { accessor } = createAccessor();
            accessor.opacity = 0.75;
            expect(accessor.opacity).toBe(0.75);
        });

        test('opacity triggers dirty callback', () => {
            const { accessor, getDirtyCount } = createAccessor();
            accessor.opacity = 0.5;
            expect(getDirtyCount()).toBe(1);
        });
    });

    describe('tint', () => {
        test('tint defaults to 0', () => {
            const { accessor } = createAccessor();
            expect(accessor.tintR).toBe(0);
            expect(accessor.tintG).toBe(0);
            expect(accessor.tintB).toBe(0);
            expect(accessor.tintA).toBe(0);
        });

        test('setTint writes RGBA values', () => {
            const { accessor } = createAccessor();
            accessor.setTint(1, 0.5, 0.25, 0.8);
            expect(accessor.tintR).toBeCloseTo(1);
            expect(accessor.tintG).toBeCloseTo(0.5);
            expect(accessor.tintB).toBeCloseTo(0.25);
            expect(accessor.tintA).toBeCloseTo(0.8);
        });

        test('setTint with default alpha of 1', () => {
            const { accessor } = createAccessor();
            accessor.setTint(1, 1, 1);
            expect(accessor.tintA).toBe(1);
        });

        test('setTint triggers dirty callback once', () => {
            const { accessor, getDirtyCount } = createAccessor();
            accessor.setTint(1, 1, 1, 1);
            expect(getDirtyCount()).toBe(1);
        });

        test('setTint writes to correct static buffer offsets', () => {
            const { accessor, staticData } = createAccessor(0);
            accessor.setTint(0.1, 0.2, 0.3, 0.4);
            expect(staticData[STATIC_OFFSET_TINT_R]).toBeCloseTo(0.1);
            expect(staticData[STATIC_OFFSET_TINT_G]).toBeCloseTo(0.2);
            expect(staticData[STATIC_OFFSET_TINT_B]).toBeCloseTo(0.3);
            expect(staticData[STATIC_OFFSET_TINT_A]).toBeCloseTo(0.4);
        });
    });

    describe('UV access', () => {
        test('UV values default to 0', () => {
            const { accessor } = createAccessor();
            expect(accessor.uvMinX).toBe(0);
            expect(accessor.uvMinY).toBe(0);
            expect(accessor.uvMaxX).toBe(0);
            expect(accessor.uvMaxY).toBe(0);
        });

        test('UV values can be read from the static buffer', () => {
            const { accessor, staticData } = createAccessor(0);
            staticData[STATIC_OFFSET_UV_MIN_X] = 0.25;
            staticData[STATIC_OFFSET_UV_MIN_Y] = 0.5;
            staticData[STATIC_OFFSET_UV_MAX_X] = 0.75;
            staticData[STATIC_OFFSET_UV_MAX_Y] = 1.0;
            expect(accessor.uvMinX).toBe(0.25);
            expect(accessor.uvMinY).toBe(0.5);
            expect(accessor.uvMaxX).toBe(0.75);
            expect(accessor.uvMaxY).toBe(1.0);
        });
    });

    describe('multiple slots in shared buffer', () => {
        test('accessors for different slots do not interfere', () => {
            const dynamicData = new Float32Array(DYNAMIC_FLOATS_PER_SPRITE * 4);
            const staticData = new Float32Array(STATIC_FLOATS_PER_SPRITE * 4);
            const noop = () => {};

            const a0 = new SpriteAccessor(dynamicData, staticData, 0, 0, noop);
            const a1 = new SpriteAccessor(dynamicData, staticData, 1, 0, noop);
            const a2 = new SpriteAccessor(dynamicData, staticData, 2, 0, noop);

            a0.x = 10;
            a1.x = 20;
            a2.x = 30;

            expect(a0.x).toBe(10);
            expect(a1.x).toBe(20);
            expect(a2.x).toBe(30);

            a0.scaleX = 1;
            a1.scaleX = 2;
            a2.scaleX = 3;

            expect(a0.scaleX).toBe(1);
            expect(a1.scaleX).toBe(2);
            expect(a2.scaleX).toBe(3);
        });
    });

    describe('negative and extreme values', () => {
        test('handles negative positions', () => {
            const { accessor } = createAccessor();
            accessor.x = -999;
            accessor.y = -0.001;
            expect(accessor.x).toBe(-999);
            expect(accessor.y).toBeCloseTo(-0.001);
        });

        test('handles zero values', () => {
            const { accessor } = createAccessor();
            accessor.x = 0;
            accessor.scaleX = 0;
            accessor.opacity = 0;
            expect(accessor.x).toBe(0);
            expect(accessor.scaleX).toBe(0);
            expect(accessor.opacity).toBe(0);
        });

        test('handles large rotation values', () => {
            const { accessor } = createAccessor();
            accessor.rotation = Math.PI * 100;
            expect(accessor.rotation).toBeCloseTo(Math.PI * 100);
        });
    });
});

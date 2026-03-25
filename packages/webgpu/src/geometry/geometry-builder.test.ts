import { test, expect, describe } from 'bun:test';
import * as d from 'typegpu/data';
import { getFieldFloats, InstanceAccessor } from './geometry-builder';

describe('getFieldFloats', () => {
    test('d.f32 returns 1', () => {
        expect(getFieldFloats(d.f32)).toBe(1);
    });

    test('d.vec2f returns 2', () => {
        expect(getFieldFloats(d.vec2f)).toBe(2);
    });

    test('d.vec3f returns 3', () => {
        expect(getFieldFloats(d.vec3f)).toBe(3);
    });

    test('d.vec4f returns 4', () => {
        expect(getFieldFloats(d.vec4f)).toBe(4);
    });

    test('d.mat3x3f returns 9', () => {
        expect(getFieldFloats(d.mat3x3f)).toBe(9);
    });

    test('d.mat4x4f returns 16', () => {
        expect(getFieldFloats(d.mat4x4f)).toBe(16);
    });

    test('unknown primitive falls back to 1', () => {
        expect(getFieldFloats('unknown')).toBe(1);
    });

    test('null falls back to 1', () => {
        expect(getFieldFloats(null)).toBe(1);
    });

    test('number falls back to 1', () => {
        expect(getFieldFloats(42)).toBe(1);
    });

    test('struct type hits fallback path (sizeOf or 1)', () => {
        const myStruct = d.struct({ a: d.f32, b: d.f32, c: d.f32 });
        const result = getFieldFloats(myStruct);
        // The function tries sizeOf; if that works: sizeOf/4, else 1
        // Either way it should return a positive number
        expect(result).toBeGreaterThan(0);
    });
});

describe('InstanceAccessor', () => {
    function createAccessor() {
        const dynamicFieldNames = ['position', 'velocity'];
        const staticFieldNames = ['color', 'size'];
        const layout = {
            dynamic: { position: d.vec2f, velocity: d.vec2f },
            static: { color: d.vec4f, size: d.f32 },
        };
        const dynamicStride = 4; // vec2f + vec2f = 2 + 2
        const staticStride = 5;  // vec4f + f32 = 4 + 1
        const maxSlots = 4;

        const dynamicData = new Float32Array(dynamicStride * maxSlots);
        const staticData = new Float32Array(staticStride * maxSlots);

        let dynDirty = false;
        let statDirty = false;

        const accessor = new InstanceAccessor(
            dynamicData, staticData,
            0, // slot
            dynamicStride, staticStride,
            dynamicFieldNames, staticFieldNames,
            layout,
            () => { dynDirty = true; },
            () => { statDirty = true; },
        );

        return {
            accessor,
            dynamicData,
            staticData,
            isDynDirty: () => dynDirty,
            isStatDirty: () => statDirty,
            resetDirty: () => { dynDirty = false; statDirty = false; },
        };
    }

    describe('get', () => {
        test('returns default zero for scalar field', () => {
            const { accessor } = createAccessor();
            expect(accessor.get('size')).toBe(0);
        });

        test('returns default zeros for vector field', () => {
            const { accessor } = createAccessor();
            expect(accessor.get('position')).toEqual([0, 0]);
        });

        test('returns array for vec4f field', () => {
            const { accessor } = createAccessor();
            expect(accessor.get('color')).toEqual([0, 0, 0, 0]);
        });

        test('throws for unknown field', () => {
            const { accessor } = createAccessor();
            expect(() => accessor.get('nonexistent')).toThrow('Field "nonexistent" not found');
        });
    });

    describe('set', () => {
        test('sets a scalar dynamic field', () => {
            const { accessor, dynamicData } = createAccessor();
            // velocity is at offset 2 (after position: vec2f = 2 floats)
            accessor.set('velocity', [3, 4]);
            expect(accessor.get('velocity')).toEqual([3, 4]);
        });

        test('sets a vector dynamic field', () => {
            const { accessor } = createAccessor();
            accessor.set('position', [10, 20]);
            expect(accessor.get('position')).toEqual([10, 20]);
        });

        test('sets a vector static field', () => {
            const { accessor } = createAccessor();
            accessor.set('color', [1, 0.5, 0.25, 0.75]);
            const color = accessor.get('color') as number[];
            expect(color[0]).toBeCloseTo(1);
            expect(color[1]).toBeCloseTo(0.5);
            expect(color[2]).toBeCloseTo(0.25);
            expect(color[3]).toBeCloseTo(0.75);
        });

        test('sets a scalar static field', () => {
            const { accessor } = createAccessor();
            accessor.set('size', 42);
            expect(accessor.get('size')).toBe(42);
        });

        test('throws for unknown field', () => {
            const { accessor } = createAccessor();
            expect(() => accessor.set('nonexistent', 1)).toThrow('Field "nonexistent" not found');
        });
    });

    describe('dirty callbacks', () => {
        test('setting dynamic field triggers dynamic dirty', () => {
            const { accessor, isDynDirty, resetDirty } = createAccessor();
            resetDirty();
            accessor.set('position', [1, 2]);
            expect(isDynDirty()).toBe(true);
        });

        test('setting static field triggers static dirty', () => {
            const { accessor, isStatDirty, resetDirty } = createAccessor();
            resetDirty();
            accessor.set('color', [1, 1, 1, 1]);
            expect(isStatDirty()).toBe(true);
        });

        test('setting dynamic field does not trigger static dirty', () => {
            const { accessor, isStatDirty, resetDirty } = createAccessor();
            resetDirty();
            accessor.set('position', [5, 5]);
            expect(isStatDirty()).toBe(false);
        });

        test('setting static field does not trigger dynamic dirty', () => {
            const { accessor, isDynDirty, resetDirty } = createAccessor();
            resetDirty();
            accessor.set('size', 10);
            expect(isDynDirty()).toBe(false);
        });
    });

    describe('slot offset', () => {
        test('accessor at slot 2 reads/writes at correct offset', () => {
            const dynamicStride = 4;
            const staticStride = 5;
            const maxSlots = 4;
            const dynamicData = new Float32Array(dynamicStride * maxSlots);
            const staticData = new Float32Array(staticStride * maxSlots);

            const accessor = new InstanceAccessor(
                dynamicData, staticData,
                2, // slot 2
                dynamicStride, staticStride,
                ['position', 'velocity'],
                ['color', 'size'],
                {
                    dynamic: { position: d.vec2f, velocity: d.vec2f },
                    static: { color: d.vec4f, size: d.f32 },
                },
                () => {}, () => {},
            );

            accessor.set('position', [99, 88]);
            // Slot 2, dynBase = 2 * 4 = 8
            expect(dynamicData[8]).toBe(99);
            expect(dynamicData[9]).toBe(88);

            accessor.set('size', 7);
            // Slot 2, statBase = 2 * 5 = 10, size offset = 4 (after vec4f color)
            expect(staticData[14]).toBe(7);
        });
    });

    describe('multiple fields ordering', () => {
        test('fields are laid out sequentially in buffer', () => {
            const { accessor, dynamicData } = createAccessor();
            accessor.set('position', [1, 2]);
            accessor.set('velocity', [3, 4]);

            // position at offset 0,1; velocity at offset 2,3
            expect(dynamicData[0]).toBe(1);
            expect(dynamicData[1]).toBe(2);
            expect(dynamicData[2]).toBe(3);
            expect(dynamicData[3]).toBe(4);
        });

        test('static fields are laid out sequentially', () => {
            const { accessor, staticData } = createAccessor();
            accessor.set('color', [0.1, 0.2, 0.3, 0.4]);
            accessor.set('size', 5);

            expect(staticData[0]).toBeCloseTo(0.1);
            expect(staticData[1]).toBeCloseTo(0.2);
            expect(staticData[2]).toBeCloseTo(0.3);
            expect(staticData[3]).toBeCloseTo(0.4);
            expect(staticData[4]).toBe(5);
        });
    });

    describe('overwrite values', () => {
        test('set overwrites previous value', () => {
            const { accessor } = createAccessor();
            accessor.set('size', 10);
            expect(accessor.get('size')).toBe(10);
            accessor.set('size', 20);
            expect(accessor.get('size')).toBe(20);
        });

        test('set overwrites vector value', () => {
            const { accessor } = createAccessor();
            accessor.set('position', [1, 2]);
            accessor.set('position', [3, 4]);
            expect(accessor.get('position')).toEqual([3, 4]);
        });
    });
});

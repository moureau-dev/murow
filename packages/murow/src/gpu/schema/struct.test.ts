import { describe, expect, test } from 'bun:test';
import { GpuStruct } from './struct';
import { Std430 } from './align';
import { f32, vec3f } from './primitives';

describe('GpuStruct', () => {
    test('computes std140 offsets and size from an array of fields', () => {
        const s = new GpuStruct({
            name: 'Foo',
            fields: [
                { name: 'a', field: f32 },
                { name: 'b', field: vec3f },
            ],
        });
        expect(s.name).toBe('Foo');
        expect(s.fields.map((m) => m.offset)).toEqual([0, 16]);
        expect(s.size).toBe(32);
        expect(s.align).toBe(16);
        expect(s.createBacking().byteLength).toBe(32);
    });

    test('accepts a record and preserves insertion order', () => {
        const s = new GpuStruct({
            name: 'Rec',
            fields: { x: f32, pos: vec3f },
        });
        expect(s.fields.map((m) => m.name)).toEqual(['x', 'pos']);
        expect(s.fields[1].offset).toBe(16);
    });

    test('mirror reads and writes field values', () => {
        const s = new GpuStruct({
            name: 'M',
            fields: [
                { name: 'a', field: f32 },
                { name: 'b', field: vec3f },
            ],
        });
        s.mirror.a = 2.5;
        s.mirror.b = [1, 2, 3];
        expect(s.mirror.a).toBe(2.5);
        expect(s.mirror.b).toEqual([1, 2, 3]);
    });

    test('writes land in the backing buffer', () => {
        const s = new GpuStruct({ name: 'B', fields: [{ name: 'a', field: f32 }] });
        s.mirror.a = 9;
        const dv = new DataView(s.createBacking());
        expect(dv.getFloat32(0, true)).toBe(9);
    });

    test('setting marks dirty and clearDirty resets', () => {
        const s = new GpuStruct({ name: 'D', fields: [{ name: 'a', field: f32 }] });
        expect(s.dirty).toBe(true);
        s.clearDirty();
        expect(s.dirty).toBe(false);
        s.mirror.a = 1;
        expect(s.dirty).toBe(true);
    });

    test('unknown names read undefined', () => {
        const s = new GpuStruct({ name: 'U', fields: [{ name: 'a', field: f32 }] });
        expect(s.mirror.missing).toBeUndefined();
        expect(s.member('a')?.name).toBe('a');
        expect(s.member('nope')).toBeUndefined();
    });

    test('std430 packing option is honored', () => {
        const s = new GpuStruct({
            name: 'P',
            packing: Std430,
            fields: [
                { name: 'a', field: f32 },
                { name: 'b', field: f32 },
            ],
        });
        expect(s.size).toBe(8);
    });

    test('emits WGSL', () => {
        const s = new GpuStruct({
            name: 'Foo',
            fields: [
                { name: 'a', field: f32 },
                { name: 'b', field: vec3f },
            ],
        });
        expect(s.wgsl()).toBe('struct Foo {\n    a: f32,\n    b: vec3<f32>,\n}');
        expect(s.wgsl('u')).toContain('var<uniform> u: Foo;');
    });

    test('emits GLSL', () => {
        const s = new GpuStruct({
            name: 'Foo',
            fields: [
                { name: 'a', field: f32 },
                { name: 'b', field: vec3f },
            ],
        });
        expect(s.glsl()).toBe('struct Foo {\n    float a;\n    vec3 b;\n};');
        expect(s.glsl('u')).toContain('uniform Foo u;');
    });
});

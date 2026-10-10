import { describe, expect, test } from 'bun:test';
import { GpuStruct } from 'murow/gpu/schema';
import { d, sizeOf } from './data';

describe('d data namespace', () => {
    test('a scalar is both a type and a constructor', () => {
        expect((d.f32 as any).kind).toBe('scalar');
        expect((d.f32 as any).scalar).toBe('f32');
        expect((d.f32 as any).size).toBe(4);
        const value: any = (d.f32 as any)(2.5);
        expect(value.node.kind).toBe('literal');
        expect(value.node.value).toBe(2.5);
        expect(value.node.type.kind).toBe('scalar');
    });

    test('vectors and matrices carry type shape and construct', () => {
        expect((d.vec3f as any).kind).toBe('vec');
        expect((d.vec3f as any).width).toBe(3);
        expect((d.mat4x4f as any).kind).toBe('mat');
        expect((d.mat4x4f as any).cols).toBe(4);
        expect((d.vec4u as any).scalar).toBe('u32');

        const v: any = (d.vec2f as any)(1, 2);
        expect(v.node.kind).toBe('construct');
        expect(v.node.type).toEqual({ kind: 'vec', scalar: 'f32', width: 2 });
    });

    test('struct exposes a GpuStruct with a StructType', () => {
        const S = d.struct({ a: d.f32, b: d.vec3f });
        expect(S).toBeInstanceOf(GpuStruct);
        expect(S.size).toBe(32);
        expect(S.align).toBe(16);
        expect(S.type.kind).toBe('struct');
        expect(S.type.name).toBe(S.name);
        expect(S.type.fields.map((field) => field.name)).toEqual(['a', 'b']);
    });

    test('arrayOf carries count, element type, and stride size', () => {
        const S = d.struct({ a: d.f32, b: d.vec3f });
        const arr = d.arrayOf(S, 2);
        expect(arr.kind).toBe('array');
        expect(arr.count).toBe(2);
        expect(arr.size).toBe(64);
        expect(arr.element.kind).toBe('struct');
        expect(arr.element.name).toBe(S.name);

        const scalars = d.arrayOf(d.u32, 4);
        expect(scalars.size).toBe(16);
        expect(scalars.align).toBe(4);
        expect(scalars.type.element.kind).toBe('scalar');
    });

    test('a struct can be used as a field of another struct', () => {
        const Inner = d.struct({ x: d.f32 });
        const Outer = d.struct({ inner: Inner, y: d.f32 });
        expect(Outer.type.fields[0].type.kind).toBe('struct');
        expect((Outer.type.fields[0].type as any).name).toBe(Inner.name);
        expect(Outer.size).toBe(8);
    });

    test('sizeOf resolves primitives, structs, and arrays', () => {
        expect(d.sizeOf(d.f32)).toBe(4);
        expect(d.sizeOf(d.vec3f)).toBe(12);
        expect(d.sizeOf(d.mat4x4f)).toBe(64);
        const S = d.struct({ a: d.f32, b: d.vec3f });
        expect(d.sizeOf(S)).toBe(32);
        expect(sizeOf(d.arrayOf(d.u32, 4))).toBe(16);
    });

    test('builtins and locations are markers', () => {
        expect((d.builtin.position as any).__builtin).toBe('position');
        expect((d.builtin.instanceIndex as any).__builtin).toBe('instance_index');
        const loc: any = d.location(1, d.vec3f);
        expect(loc.__location).toBe(1);
        expect(loc.type.kind).toBe('vec');
    });

    test('aliases point at their canonical types', () => {
        expect(d.v3f).toBe(d.vec3f);
        expect(d.v4f).toBe(d.vec4f);
        expect(d.v2f).toBe(d.vec2f);
    });
});

import { describe, expect, test } from 'bun:test';
import { d } from './data';
import type { IrConstruct, IrLiteral } from '../ir/nodes';
import { bool, f32, i32, mat, u32, vec } from '../ir/types';
import { f32 as f32Field, vec3f as vec3fField } from '../schema/primitives';

describe('d scalars', () => {
    test('numeric literals carry their type', () => {
        expect(d.f32(1.5).node).toEqual({ kind: 'literal', type: f32(), value: 1.5 });
        expect((d.i32(-2).node as IrLiteral).type).toEqual(i32());
        expect((d.u32(7).node as IrLiteral).type).toEqual(u32());
        expect((d.bool(true).node as IrLiteral).type).toEqual(bool());
    });
});

describe('d vectors', () => {
    test('vec constructors build construct nodes', () => {
        const node = d.vec2f(1, 2).node as IrConstruct;
        expect(node.kind).toBe('construct');
        expect(node.type).toEqual(vec('f32', 2));
        expect(node.args).toHaveLength(2);

        expect((d.vec3f(1, 2, 3).node as IrConstruct).type).toEqual(vec('f32', 3));
        expect((d.vec4f(1, 2, 3, 4).node as IrConstruct).args).toHaveLength(4);
    });

    test('mat4x4f builds a 16-arg construct', () => {
        const node = d.mat4x4f(...Array.from({ length: 16 }, (_, i) => i)).node as IrConstruct;
        expect(node.type).toEqual(mat('f32', 4, 4));
        expect(node.args).toHaveLength(16);
    });
});

describe('d composites', () => {
    test('array uses the element type and value count', () => {
        const node = d.array(f32(), [1, 2, 3]).node as IrConstruct;
        expect(node.type).toEqual({ kind: 'array', element: f32(), count: 3 });
        expect(node.args).toHaveLength(3);
    });

    test('struct builds a schema with the declared fields', () => {
        const material = d.struct({ a: f32Field, b: vec3fField });
        expect(material.type.kind).toBe('struct');
        expect(material.fields.map((field) => field.name)).toEqual(['a', 'b']);
    });
});

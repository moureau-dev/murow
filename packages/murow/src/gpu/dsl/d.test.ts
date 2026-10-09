import { describe, expect, test } from 'bun:test';
import { d } from './d';
import type { IrConstruct, IrLiteral } from '../ir/nodes';
import { bool, f32, i32, mat, struct, u32, vec } from '../ir/types';

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

    test('struct orders args by field', () => {
        const type = struct('S', [
            { name: 'a', type: f32() },
            { name: 'b', type: vec('f32', 3) },
        ]);
        const node = d.struct(type, { b: d.vec3f(1, 2, 3), a: d.f32(1) }).node as IrConstruct;
        expect(node.type).toEqual(type);
        expect(node.args).toHaveLength(2);
        expect((node.args[0] as IrLiteral).value).toBe(1);
    });

    test('struct throws on a missing field', () => {
        const type = struct('S', [{ name: 'a', type: f32() }]);
        expect(() => d.struct(type, {})).toThrow();
    });
});

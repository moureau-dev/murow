import { describe, expect, test } from 'bun:test';
import { ShaderValue, combineType, componentScalar, scalarOf, toExpr, vecOf } from './value';
import { local } from '../ir/builders';
import type { IrBinary, IrCall, IrSwizzle, IrUnary } from '../ir/nodes';
import { f32, vec } from '../ir/types';

const f = f32();
const v3 = vec('f32', 3);

function scalarValue(id = 0): ShaderValue {
    return new ShaderValue({ node: local(f, id) });
}

function vecValue(id = 0): ShaderValue {
    return new ShaderValue({ node: local(v3, id) });
}

describe('ShaderValue', () => {
    test('wraps an expression and exposes its type', () => {
        const value = scalarValue();
        expect(value.node.kind).toBe('local');
        expect(value.type).toEqual(f);
    });

    test('arithmetic builds binary nodes', () => {
        const add = scalarValue(0).add(scalarValue(1)).node as IrBinary;
        expect(add.kind).toBe('binary');
        expect(add.op).toBe('+');

        expect((scalarValue().sub(scalarValue()).node as IrBinary).op).toBe('-');
        expect((scalarValue().mul(scalarValue()).node as IrBinary).op).toBe('*');
        expect((scalarValue().div(scalarValue()).node as IrBinary).op).toBe('/');
    });

    test('scalar op vector widens to the vector type', () => {
        const node = scalarValue().mul(vecValue());
        expect(node.type).toEqual(v3);
    });

    test('neg builds a unary node', () => {
        const node = scalarValue().neg().node as IrUnary;
        expect(node.kind).toBe('unary');
        expect(node.op).toBe('-');
    });

    test('dot builds a call with a scalar result', () => {
        const node = vecValue(0).dot(vecValue(1)).node as IrCall;
        expect(node.kind).toBe('call');
        expect(node.name).toBe('dot');
        expect(vecValue().dot(vecValue()).type).toEqual(f);
    });

    test('swizzle derives the result type', () => {
        const node = vecValue().swizzle('xyz').node as IrSwizzle;
        expect(node.kind).toBe('swizzle');
        expect(node.mask).toBe('xyz');
        expect(vecValue().swizzle('xyz').type).toEqual(v3);
        expect(vecValue().swizzle('x').type).toEqual(f);
    });

    test('component getters swizzle', () => {
        const node = vecValue().x.node as IrSwizzle;
        expect(node.kind).toBe('swizzle');
        expect(node.mask).toBe('x');
    });
});

describe('value helpers', () => {
    test('toExpr unwraps values and boxes numbers', () => {
        const value = scalarValue();
        expect(toExpr(value)).toBe(value.node);
        expect(toExpr(2)).toEqual({ kind: 'literal', type: f, value: 2 });
        expect(toExpr(true)).toEqual({ kind: 'literal', type: { kind: 'scalar', scalar: 'bool' }, value: true });
    });

    test('combineType widens a scalar operand', () => {
        expect(combineType(f, v3)).toEqual(v3);
        expect(combineType(v3, f)).toEqual(v3);
        expect(combineType(f, f)).toEqual(f);
    });

    test('component helpers', () => {
        expect(componentScalar(v3)).toBe('f32');
        expect(scalarOf(v3)).toEqual(f);
        expect(vecOf(v3, 4)).toEqual(vec('f32', 4));
    });
});

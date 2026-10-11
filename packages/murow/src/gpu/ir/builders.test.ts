import { describe, expect, test } from 'bun:test';
import {
    access,
    assignStmt,
    binary,
    binding,
    builtin,
    call,
    construct,
    discardStmt,
    entry,
    ifStmt,
    letStmt,
    literal,
    local,
    loopStmt,
    param,
    returnStmt,
    sample,
    swizzle,
    unary,
} from './builders';
import type { IrExpr, IrStmt } from './nodes';
import { array, f32, mat, scalar, struct, swizzleType, texture, typeEquals, vec } from './types';

const f = f32();
const v3 = vec('f32', 3);
const v4 = vec('f32', 4);
const value: IrExpr = literal(f, 1);

describe('expression builders', () => {
    test('literal carries type and value', () => {
        expect(literal(f, 1.5)).toEqual({ kind: 'literal', type: f, value: 1.5 });
        expect(literal(f, [1, 2, 3]).value).toEqual([1, 2, 3]);
    });

    test('local, binding, builtin reference', () => {
        expect(local(f, 7)).toEqual({ kind: 'local', type: f, id: 7 });
        expect(binding(v4, 0, 2)).toEqual({ kind: 'binding', type: v4, group: 0, binding: 2 });
        expect(builtin(v4, 'position')).toEqual({ kind: 'builtin', type: v4, name: 'position' });
    });

    test('unary and binary', () => {
        const a = local(f, 0);
        const b = local(f, 1);
        expect(unary(f, '-', a)).toEqual({ kind: 'unary', type: f, op: '-', value: a });
        expect(binary(f, '+', a, b)).toEqual({ kind: 'binary', type: f, op: '+', left: a, right: b });
    });

    test('construct copies args', () => {
        const args = [literal(f, 0), literal(f, 1)];
        const node = construct(v3, args);
        args.push(literal(f, 2));
        expect(node.args).toHaveLength(2);
        expect(node.args[0]).toBe(args[0] as IrExpr);
    });

    test('access supports string and expression indices', () => {
        const target = local(v4, 0);
        expect(access(f, target, 'x')).toEqual({ kind: 'access', type: f, value: target, index: 'x' });
        const indexed = access(f, target, literal(f, 0));
        expect(typeof indexed.index).toBe('object');
    });

    test('call and sample', () => {
        const tex = binding(texture('f32', '2d', 'sample'), 0, 0);
        const smp = binding({ kind: 'sampler', comparison: false }, 0, 1);
        const uv = local(vec('f32', 2), 0);
        expect(call(f, 'abs', [uv])).toEqual({ kind: 'call', type: f, name: 'abs', args: [uv] });
        expect(sample(v4, tex, smp, uv)).toEqual({
            kind: 'sample',
            type: v4,
            texture: tex,
            sampler: smp,
            coords: uv,
        });
    });
});

describe('swizzle', () => {
    test('derives vector result type from the mask', () => {
        const node = swizzle(local(v4, 0), 'xyz');
        expect(node.type).toEqual(vec('f32', 3));
    });

    test('derives scalar result type for a single component', () => {
        expect(swizzle(local(v4, 0), 'x').type).toEqual(f);
    });

    test('leaves non-vector input type unchanged', () => {
        expect(swizzle(local(f, 0), 'x').type).toEqual(f);
    });
});

describe('statement builders', () => {
    test('let and assign', () => {
        expect(letStmt(3, f, value)).toEqual({ kind: 'let', id: 3, type: f, value });
        const target = local(f, 0);
        expect(assignStmt(target, value)).toEqual({ kind: 'assign', target, value });
    });

    test('if copies branches and defaults otherwise to null', () => {
        const then: IrStmt[] = [discardStmt()];
        const node = ifStmt(value, then);
        then.push(discardStmt());
        expect(node.then).toHaveLength(1);
        expect(node.otherwise).toBeNull();

        const withElse = ifStmt(value, [], [returnStmt(value)]);
        expect(withElse.otherwise).toHaveLength(1);
    });

    test('loop, return and discard', () => {
        expect(loopStmt([discardStmt()])).toEqual({ kind: 'loop', body: [discardStmt()] });
        expect(returnStmt()).toEqual({ kind: 'return', value: null });
        expect(returnStmt(value)).toEqual({ kind: 'return', value });
        expect(discardStmt()).toEqual({ kind: 'discard' });
    });
});

describe('entry', () => {
    test('assembles stage, params, body and optional workgroup size', () => {
        const p = param('uv', vec('f32', 2), 0);
        const node = entry({ stage: 'fragment', params: [p], body: [returnStmt(value)] });
        expect(node.stage).toBe('fragment');
        expect(node.params).toEqual([p]);
        expect(node.body).toHaveLength(1);
        expect(node.workgroupSize).toBeUndefined();

        const compute = entry({
            stage: 'compute',
            params: [],
            body: [],
            workgroupSize: [8, 8, 1],
        });
        expect(compute.workgroupSize).toEqual([8, 8, 1]);
    });
});

describe('type helpers', () => {
    test('swizzleType', () => {
        expect(swizzleType(vec('f32', 4), 'xy')).toEqual(vec('f32', 2));
        expect(swizzleType(vec('f32', 4), 'x')).toEqual(f32());
        expect(swizzleType(f32(), 'x')).toEqual(f32());
    });

    test('typeEquals is structural', () => {
        expect(typeEquals(vec('f32', 3), vec('f32', 3))).toBe(true);
        expect(typeEquals(vec('f32', 3), vec('f32', 4))).toBe(false);
        expect(typeEquals(array(f32(), 4), array(f32(), 4))).toBe(true);
        expect(typeEquals(array(f32(), null), array(f32(), 4))).toBe(false);
        expect(
            typeEquals(
                struct('S', [{ name: 'a', type: f32() }]),
                struct('S', [{ name: 'a', type: f32() }]),
            ),
        ).toBe(true);
        expect(typeEquals(f32(), scalar('i32'))).toBe(false);
        expect(typeEquals(mat('f32', 4, 4), mat('f32', 4, 4))).toBe(true);
    });
});

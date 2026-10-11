import { describe, expect, test } from 'bun:test';
import { body, branch, loop, select } from './control';
import { ShaderValue } from './value';
import { local, returnStmt } from '../ir/builders';
import type { IrCall, IrIf, IrLoop } from '../ir/nodes';
import { bool, f32, vec } from '../ir/types';

const f = f32();
const cond = new ShaderValue({ node: local(bool(), 0) });
const scalar = (id: number) => new ShaderValue({ node: local(f, id) });

describe('branch', () => {
    test('builds an if with a then block and no else', () => {
        const node = branch(cond, [returnStmt(cond.node)]) as IrIf;
        expect(node.kind).toBe('if');
        expect(node.cond).toBe(cond.node);
        expect(node.then).toHaveLength(1);
        expect(node.otherwise).toBeNull();
    });

    test('accepts a single statement and an else block', () => {
        const node = branch(cond, returnStmt(null), returnStmt(null)) as IrIf;
        expect(node.then).toHaveLength(1);
        expect(node.otherwise).toHaveLength(1);
    });
});

describe('loop', () => {
    test('builds a loop', () => {
        const node = loop([returnStmt(null)]) as IrLoop;
        expect(node.kind).toBe('loop');
        expect(node.body).toHaveLength(1);
    });
});

describe('select', () => {
    test('boxes the condition last and keeps the value type', () => {
        const a = new ShaderValue({ node: local(vec('f32', 3), 1) });
        const b = new ShaderValue({ node: local(vec('f32', 3), 2) });
        const node = select(cond, a, b).node as IrCall;
        expect(node.kind).toBe('call');
        expect(node.name).toBe('select');
        expect(node.args[0]).toBe(a.node);
        expect(node.args[1]).toBe(b.node);
        expect(node.args[2]).toBe(cond.node);
        expect(node.type).toEqual(vec('f32', 3));
    });
});

describe('body', () => {
    test('flattens statements and lists', () => {
        const one = returnStmt(scalar(0).node);
        const two = returnStmt(scalar(1).node);
        expect(body(one, [two, one])).toEqual([one, two, one]);
    });
});

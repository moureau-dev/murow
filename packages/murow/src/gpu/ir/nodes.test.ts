import { describe, expect, test } from 'bun:test';
import {
    isExpr,
    isStmt,
    isTerminator,
    isValue,
    walkEntry,
    type IrEntry,
    type IrExpr,
    type IrStmt,
} from './nodes';
import { f32, vec } from './types';

const litA: IrExpr = { kind: 'literal', type: f32(), value: 1 };
const locA: IrExpr = { kind: 'local', type: f32(), id: 0 };
const cond: IrExpr = { kind: 'binary', type: f32(), op: '<', left: locA, right: litA };
const position: IrExpr = { kind: 'builtin', type: vec('f32', 4), name: 'position' };
const letNode: IrStmt = { kind: 'let', id: 0, type: f32(), value: litA };
const returnNode: IrStmt = { kind: 'return', value: null };
const discardNode: IrStmt = { kind: 'discard' };

describe('isExpr / isStmt', () => {
    test('classifies expressions', () => {
        expect(isExpr(litA)).toBe(true);
        expect(isExpr(locA)).toBe(true);
        expect(isExpr(cond)).toBe(true);
        expect(isExpr(letNode)).toBe(false);
        expect(isExpr(returnNode)).toBe(false);
    });

    test('classifies statements as the complement', () => {
        expect(isStmt(letNode)).toBe(true);
        expect(isStmt(returnNode)).toBe(true);
        expect(isStmt(discardNode)).toBe(true);
        expect(isStmt(litA)).toBe(false);
    });
});

describe('isTerminator', () => {
    test('matches return and discard only', () => {
        expect(isTerminator(returnNode)).toBe(true);
        expect(isTerminator(discardNode)).toBe(true);
        expect(isTerminator(letNode)).toBe(false);
        expect(isTerminator(litA)).toBe(false);
    });
});

describe('isValue', () => {
    test('matches leaf value references', () => {
        expect(isValue(litA)).toBe(true);
        expect(isValue(locA)).toBe(true);
        expect(isValue({ kind: 'binding', type: f32(), group: 0, binding: 0 })).toBe(true);
        expect(isValue(position)).toBe(true);
    });

    test('rejects computed expressions', () => {
        expect(isValue(cond)).toBe(false);
        expect(isValue(letNode)).toBe(false);
    });
});

describe('walkEntry', () => {
    const entry: IrEntry = {
        stage: 'fragment',
        params: [],
        body: [
            letNode,
            {
                kind: 'if',
                cond,
                then: [{ kind: 'assign', target: locA, value: litA }],
                otherwise: [discardNode],
            },
            { kind: 'loop', body: [{ kind: 'let', id: 1, type: f32(), value: locA }] },
            { kind: 'return', value: position },
        ],
    };

    test('visits every node in pre-order', () => {
        const kinds: string[] = [];
        walkEntry(entry, (node) => kinds.push(node.kind));

        expect(kinds).toEqual([
            'let', 'literal',
            'if', 'binary', 'local', 'literal', 'assign', 'local', 'literal', 'discard',
            'loop', 'let', 'local',
            'return', 'builtin',
        ]);
    });

    test('visits the node before its children', () => {
        const order: string[] = [];
        walkEntry(entry, (node) => order.push(node.kind));
        expect(order.indexOf('if')).toBeLessThan(order.indexOf('binary'));
        expect(order.indexOf('return')).toBeLessThan(order.indexOf('builtin'));
    });
});

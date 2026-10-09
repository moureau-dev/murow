import { test, expect, describe } from 'bun:test';
import {
    binary,
    call,
    entry,
    letStmt,
    literal,
    local,
    returnStmt,
    unary,
} from '../ir/builders';
import type { IrLet, IrReturn } from '../ir/nodes';
import { f32 } from '../ir/types';
import { PassPipeline, SHARED_PASSES, constantFoldPass, deadLetPass } from './passes';

describe('constantFoldPass', () => {
    test('folds scalar binary arithmetic', () => {
        const value = binary(f32(), '+', literal(f32(), 1), literal(f32(), 2));
        const input = entry({ stage: 'fragment', params: [], body: [returnStmt(value)] });
        const output = constantFoldPass.run(input);
        const ret = output.body[0] as IrReturn;
        expect(ret.value).toEqual(literal(f32(), 3));
    });

    test('folds nested binary operations', () => {
        const value = binary(
            f32(),
            '*',
            binary(f32(), '+', literal(f32(), 2), literal(f32(), 3)),
            literal(f32(), 4),
        );
        const input = entry({ stage: 'fragment', params: [], body: [returnStmt(value)] });
        const output = constantFoldPass.run(input);
        expect((output.body[0] as IrReturn).value).toEqual(literal(f32(), 20));
    });

    test('folds unary negation', () => {
        const value = unary(f32(), '-', literal(f32(), 5));
        const input = entry({ stage: 'fragment', params: [], body: [returnStmt(value)] });
        const output = constantFoldPass.run(input);
        expect((output.body[0] as IrReturn).value).toEqual(literal(f32(), -5));
    });

    test('does not fold non-literals', () => {
        const value = binary(f32(), '+', local(f32(), 0), literal(f32(), 2));
        const input = entry({ stage: 'fragment', params: [], body: [returnStmt(value)] });
        const output = constantFoldPass.run(input);
        expect((output.body[0] as IrReturn).value).toEqual(value);
    });

    test('returns a new entry and leaves the input untouched', () => {
        const value = binary(f32(), '+', literal(f32(), 1), literal(f32(), 2));
        const input = entry({ stage: 'fragment', params: [], body: [returnStmt(value)] });
        const output = constantFoldPass.run(input);
        expect(output).not.toBe(input);
        expect(input.body[0]).not.toBe(output.body[0]);
    });
});

describe('deadLetPass', () => {
    test('removes unused pure lets', () => {
        const input = entry({
            stage: 'fragment',
            params: [],
            body: [
                letStmt(0, f32(), literal(f32(), 1)),
                letStmt(1, f32(), literal(f32(), 2)),
                returnStmt(local(f32(), 1)),
            ],
        });
        const output = deadLetPass.run(input);
        expect(output.body).toHaveLength(2);
        expect((output.body[0] as IrLet).id).toBe(1);
    });

    test('keeps lets whose value may have side effects', () => {
        const input = entry({
            stage: 'fragment',
            params: [],
            body: [
                letStmt(0, f32(), call(f32(), 'sideEffect', [])),
                returnStmt(literal(f32(), 0)),
            ],
        });
        const output = deadLetPass.run(input);
        expect(output.body).toHaveLength(2);
    });

    test('keeps used lets', () => {
        const input = entry({
            stage: 'fragment',
            params: [],
            body: [
                letStmt(0, f32(), literal(f32(), 1)),
                returnStmt(local(f32(), 0)),
            ],
        });
        const output = deadLetPass.run(input);
        expect(output.body).toHaveLength(2);
    });
});

describe('PassPipeline', () => {
    test('runs shared then backend passes in order', () => {
        const order: string[] = [];
        const input = entry({ stage: 'fragment', params: [], body: [] });
        const first = { name: 'first', run: (e: typeof input) => (order.push('first'), e) };
        const second = { name: 'second', run: (e: typeof input) => (order.push('second'), e) };
        const pipeline = new PassPipeline({ shared: [first], backend: [second] });
        pipeline.run(input);
        expect(order).toEqual(['first', 'second']);
        expect(pipeline.passes.map((p) => p.name)).toEqual(['first', 'second']);
    });

    test('exposes the shared defaults', () => {
        expect(SHARED_PASSES.map((pass) => pass.name)).toEqual(['constant-fold', 'dead-let']);
    });
});

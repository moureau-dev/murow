import { describe, expect, test } from 'bun:test';
import { emitEntry } from '../codegen/emit';
import { createTestBackend } from '../codegen/test-syntax';
import { binary, literal } from '../ir/builders';
import type { IrExpr } from '../ir/nodes';
import { f32 } from '../ir/types';
import { parseShaderBody } from './parse';

describe('parseShaderBody externals', () => {
    test('resolves a bare external value', () => {
        const code = emitEntry(
            parseShaderBody('(_v,_m,s) => s.vec4f(externalValue, 0, 0, 1)', {
                stage: 'fragment',
                externals: { externalValue: literal(f32(), 7) },
            }),
            createTestBackend(),
        ).code;
        expect(code).toContain('7.0');
    });

    test('resolves member access on an external object', () => {
        const env = { $: { uniformValue: literal(f32(), 3) } };
        const code = emitEntry(
            parseShaderBody('(_v,_m,s) => s.vec4f(env.$.uniformValue, 0, 0, 1)', {
                stage: 'fragment',
                externals: { env },
            }),
            createTestBackend(),
        ).code;
        expect(code).toContain('3.0');
    });

    test('calls an external function with lowered args', () => {
        const mulTwo = (x: IrExpr) => binary(f32(), '*', x, literal(f32(), 2));
        const code = emitEntry(
            parseShaderBody('(_v,_m,s) => s.vec4f(mulTwo(s.f32(4)), 0, 0, 1)', {
                stage: 'fragment',
                externals: { mulTwo },
            }),
            createTestBackend(),
        ).code;
        expect(code).toContain('2.0');
    });
});

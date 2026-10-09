import { test, expect, describe } from 'bun:test';
import {
    construct,
    entry,
    local,
    output,
    param,
    returnStmt,
} from '../ir/builders';
import { field, struct, vec } from '../ir/types';
import { emitEntry } from './emit';
import { TestWgslBackend } from './test-syntax';

describe('vertex output structs', () => {
    test('emits a vertex entry returning a struct of varyings', () => {
        const vsOut = struct('vs_out', [
            field('pos', vec('f32', 4)),
            field('vNormal', vec('f32', 3)),
            field('vUV', vec('f32', 2)),
        ]);
        const vertex = entry({
            stage: 'vertex',
            params: [
                param('position', vec('f32', 3), 0),
                param('normal', vec('f32', 3), 1),
                param('uv', vec('f32', 2), 2),
            ],
            outputs: [
                output('pos', vec('f32', 4), { builtin: 'position' }),
                output('vNormal', vec('f32', 3), { location: 0 }),
                output('vUV', vec('f32', 2), { location: 1 }),
            ],
            body: [
                returnStmt(
                    construct(vsOut, [
                        local(vec('f32', 4), 0),
                        local(vec('f32', 3), 1),
                        local(vec('f32', 2), 2),
                    ]),
                ),
            ],
        });

        const code = emitEntry(vertex, new TestWgslBackend()).code;

        expect(code).toContain('struct vs_out {');
        expect(code).toContain('    @builtin(position) pos: vec4<f32>,');
        expect(code).toContain('    @location(0) vNormal: vec3<f32>,');
        expect(code).toContain('    @location(1) vUV: vec2<f32>,');
        expect(code).toContain(
            'fn vs_main(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>) -> vs_out {',
        );
        expect(code).toContain('return vs_out(v0, v1, v2);');
        expect(code.split('struct vs_out').length - 1).toBe(1);
        expect(code.indexOf('struct vs_out')).toBeLessThan(code.indexOf('fn vs_main'));
    });

    test('leaves a single-return vertex entry unchanged', () => {
        const vertex = entry({
            stage: 'vertex',
            params: [param('pos', vec('f32', 3), 0)],
            body: [returnStmt(local(vec('f32', 4), 0))],
        });

        const code = emitEntry(vertex, new TestWgslBackend()).code;
        expect(code).toContain('fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {');
        expect(code).not.toContain('vs_out');
    });
});

import { describe, expect, test } from 'bun:test';
import { emitEntry } from 'murow/gpu/codegen';
import { construct, entry, f32, literal, param, returnStmt, vec } from 'murow/gpu/ir';
import { WgslBackend } from './wgsl-backend';

describe('WgslBackend', () => {
    test('emits a fragment entry', () => {
        const frag = entry({
            stage: 'fragment',
            params: [param('uv', vec('f32', 2), 0)],
            body: [
                returnStmt(construct(vec('f32', 4), [
                    literal(f32(), 1),
                    literal(f32(), 0),
                    literal(f32(), 0),
                    literal(f32(), 1),
                ])),
            ],
        });
        const { code, entryName } = emitEntry(frag, new WgslBackend());
        expect(entryName).toBe('fs_main');
        expect(code).toContain('@fragment');
        expect(code).toContain('fn fs_main(@location(0) uv: vec2<f32>)');
        expect(code).toContain('return vec4<f32>(1.0, 0.0, 0.0, 1.0);');
    });
});

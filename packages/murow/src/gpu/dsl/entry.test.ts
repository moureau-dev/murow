import { describe, expect, test } from 'bun:test';
import { compute, fragment, shader, vertex } from './entry';
import { f32, vec } from '../ir/types';

describe('fragment and vertex', () => {
    test('an expression body is wrapped in a return', () => {
        const node = fragment((_p, _m, s) => s.f32(1));
        expect(node.stage).toBe('fragment');
        expect(node.body).toHaveLength(1);
        expect(node.body[0].kind).toBe('return');
    });

    test('a statement array body is kept as is', () => {
        const node = fragment((_p, _m, s) => [s.discard()]);
        expect(node.body).toEqual([{ kind: 'discard' }]);
    });

    test('params and material options become entry inputs and bindings', () => {
        let captured: Record<string, unknown> = {};
        const node = fragment(
            { params: { uv: vec('f32', 2) }, material: { tint: vec('f32', 4) } },
            (p, m, s) => {
                captured = { param: p.uv.node, material: m.tint.node };
                return s.f32(1);
            },
        );
        expect(node.params).toEqual([{ name: 'uv', type: vec('f32', 2), location: 0 }]);
        expect((captured.param as { kind: string; name: string }).kind).toBe('builtin');
        expect((captured.param as { name: string }).name).toBe('uv');
        expect((captured.material as { kind: string }).kind).toBe('binding');
    });

    test('vertex sets the stage', () => {
        expect(vertex((_p, _m, s) => s.f32(1)).stage).toBe('vertex');
    });
});

describe('compute', () => {
    test('defaults the workgroup size', () => {
        const node = compute((_p, _m, s) => s.f32(1));
        expect(node.stage).toBe('compute');
        expect(node.workgroupSize).toEqual([1, 1, 1]);
    });

    test('accepts a workgroup size option', () => {
        const node = compute({ workgroupSize: [8, 8, 1] }, (_p, _m, s) => s.f32(1));
        expect(node.workgroupSize).toEqual([8, 8, 1]);
    });
});

describe('shader namespace', () => {
    test('composes vertex and fragment only', () => {
        expect(shader.vertex).toBe(vertex);
        expect(shader.fragment).toBe(fragment);
        expect('compute' in shader).toBe(false);
    });
});

import { describe, expect, test } from 'bun:test';
import { emitEntry } from 'murow/gpu/codegen';
import { construct, entry, f32, literal, param, returnStmt, vec } from 'murow/gpu/ir';
import { WgslBackend, wgslSpec } from './backend';
import { GpuBackend, GpuBindGroupLayout, GpuProgram, GpuShader } from 'murow/gpu';
import { d, std } from 'murow/gpu/dsl';
import { gpuStruct, vec4f } from 'murow/gpu/schema';

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

describe('wgslSpec', () => {
    test('compiles a linked program to WGSL', () => {
        const Material = gpuStruct({ name: 'Material', fields: { tint: vec4f } });
        const layout = new GpuBindGroupLayout({ material: { uniform: Material } });
        const frag = GpuShader.fragment(
            { in: { vUV: d.vec2f }, out: vec('f32', 4), bindings: { mat: layout } },
            (input, { mat }) =>
                d.vec4f(mat.material.tint.x, input.vUV.x, input.vUV.y, 1),
        );
        const program = GpuProgram.link([frag]);
        const { code, layouts } = new GpuBackend(wgslSpec).compile(program);
        expect(layouts.length).toBe(1);
        expect(code).toContain('@fragment');
        expect(code).toContain('@group(0) @binding(0) var<uniform>');
    });

    test('emits comparison builtins', () => {
        const frag = GpuShader.fragment(
            { in: { v: d.f32 }, out: vec('f32', 4) },
            (input) => {
                const a = input.v;
                const zero = d.vec4f(0, 0, 0, 1);
                if (std.lt(a, d.f32(1))) { return d.vec4f(1, 0, 0, 1); }
                if (std.gt(a, d.f32(2))) { return d.vec4f(0, 1, 0, 1); }
                if (std.lte(a, d.f32(3))) { return d.vec4f(0, 0, 1, 1); }
                if (std.gte(a, d.f32(4))) { return d.vec4f(1, 1, 0, 1); }
                if (std.eq(a, d.f32(5))) { return d.vec4f(0, 1, 1, 1); }
                if (std.not(std.lt(a, d.f32(6)))) { return d.vec4f(1, 0, 1, 1); }
                return zero;
            },
        );
        const { code } = new GpuBackend(wgslSpec).compile(GpuProgram.link([frag]));
        expect(code).toContain(' < ');
        expect(code).toContain(' > ');
        expect(code).toContain(' <= ');
        expect(code).toContain(' >= ');
        expect(code).toContain(' == ');
        expect(code).toContain('!');
    });
});

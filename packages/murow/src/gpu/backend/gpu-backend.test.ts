import { describe, expect, test } from 'bun:test';
import { ALL_CAPABILITIES } from '../codegen';
import { TestWgslSyntax } from '../codegen/test-syntax';
import { d } from '../dsl/data';
import { vec } from '../ir/types';
import { vec4f } from '../schema/primitives';
import { gpuStruct } from '../schema/struct';
import { GpuBindGroupLayout } from '../resources/bind-group';
import { GpuShader } from '../shader/gpu-shader';
import { GpuProgram } from '../shader/gpu-program';
import { GpuBackend } from './gpu-backend';

describe('GpuBackend', () => {
    test('compiles a linked program and reports its layouts', () => {
        const Material = gpuStruct({ name: 'Material', fields: { tint: vec4f } });
        const matLayout = new GpuBindGroupLayout({ material: { uniform: Material } });
        const backend = new GpuBackend({
            name: 'test',
            capabilities: ALL_CAPABILITIES,
            syntax: new TestWgslSyntax(),
        });

        const frag = GpuShader.fragment(
            { in: { vUV: vec('f32', 2) }, out: vec('f32', 4), bindings: { mat: matLayout } },
            (input: any, { mat }: any) => d.vec4f(mat.material.tint.x, input.vUV.x, input.vUV.y, 1),
        );

        const program = GpuProgram.link([frag]);
        const { code, layouts } = backend.compile(program);

        expect(layouts.length).toBe(1);
        expect(layouts[0]!.group).toBe(0);
        expect(code).toContain('@group(0) @binding(0)');
        expect(code).toContain('@fragment');
        expect(code).toContain('tint');
    });

    test('exposes configured capabilities', () => {
        const backend = new GpuBackend({
            name: 'test',
            capabilities: { ...ALL_CAPABILITIES, compute: false },
            syntax: new TestWgslSyntax(),
        });
        expect(backend.capabilities.compute).toBe(false);
    });
});

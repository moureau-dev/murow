import { test, expect, describe } from 'bun:test';
import { shader, d, std } from './index';
import { compileShader, RuntimeCompiler } from './index';
import { TestWgslBackend } from '../codegen/test-syntax';
import { mat, vec } from '../ir';

describe('compileShader', () => {
    test('emits WGSL for a fragment entry', () => {
        const entry = shader.fragment((_v, _m, s) => {
            const color = s.vec4f(s.f32(1), s.f32(0), s.f32(0), s.f32(1));
            return color;
        });

        const code = compileShader(entry, new TestWgslBackend());
        expect(code).toContain('@fragment');
        expect(code).toContain('fn fs_main');
        expect(code).toContain('return vec4<f32>(1.0, 0.0, 0.0, 1.0);');
    });

    test('emits param locations and material bindings for a vertex entry', () => {
        const entry = shader.vertex(
            (attrs, material, s) => {
                const world = s.mul(attrs.pos, material.mvp);
                return world;
            },
            {
                params: { pos: vec('f32', 3) },
                material: { mvp: mat('f32', 4, 4) },
            },
        );

        const code = compileShader(entry, new TestWgslBackend());
        expect(code).toContain('@vertex');
        expect(code).toContain('@location(0) pos: vec3<f32>');
        expect(code).toContain('@group(0) @binding(0) var<uniform> binding_0_0: mat4x4<f32>;');
        expect(code).toContain('fn vs_main');
    });

    test('accepts an explicit backend', () => {
        const entry = shader.fragment((_v, _m, s) => s.vec4f(s.f32(0), s.f32(0), s.f32(0), s.f32(1)));
        const code = compileShader(entry, new TestWgslBackend());
        expect(code).toContain('@fragment');
    });
});

describe('RuntimeCompiler', () => {
    test('compiles an entry and reports its metadata', () => {
        const entry = shader.fragment((_v, _m, s) =>
            s.vec4f(s.f32(0), s.f32(0), s.f32(0), s.f32(1)),
        );
        const compiler = new RuntimeCompiler({ backend: new TestWgslBackend() });
        const result = compiler.compile(entry);
        expect(result.stage).toBe('fragment');
        expect(result.entryName).toBe('fs_main');
        expect(result.code).toContain('fn fs_main');
    });

    test('reuses one backend across compiles', () => {
        const backend = new TestWgslBackend();
        const compiler = new RuntimeCompiler({ backend });
        const entry = shader.fragment((_v, _m, s) =>
            s.vec4f(s.f32(0), s.f32(0), s.f32(0), s.f32(1)),
        );
        expect(compiler.compile(entry).code).toContain('@fragment');
        expect(compiler.compile(entry).code).toContain('@fragment');
    });
});

describe('authoring surface', () => {
    test('re-exports the dsl namespaces', () => {
        expect(typeof shader.fragment).toBe('function');
        expect(typeof d.f32).toBe('function');
        expect(typeof std.normalize).toBe('function');
    });
});

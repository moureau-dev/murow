import { test, expect, describe } from 'bun:test';
import { construct, entry, literal, param, returnStmt } from '../ir/builders';
import { f32, vec } from '../ir/types';
import { WgslBackend } from '../codegen/emit';
import { ShaderCompiler, transform } from './transform';

function computeEntry() {
    return entry({
        stage: 'compute',
        params: [],
        workgroupSize: [8, 8, 1],
        body: [returnStmt(null)],
    });
}

function vertexEntry() {
    return entry({
        stage: 'vertex',
        params: [param('pos', vec('f32', 3), 0)],
        body: [
            returnStmt(
                construct(vec('f32', 4), [
                    literal(f32(), 1),
                    literal(f32(), 1),
                    literal(f32(), 1),
                    literal(f32(), 1),
                ]),
            ),
        ],
    });
}

describe('ShaderCompiler', () => {
    test('compiles an entry and caches the artifact by name', () => {
        const compiler = new ShaderCompiler({ backend: new WgslBackend() });
        const artifact = compiler.compile(computeEntry(), 'reduce');

        expect(artifact.name).toBe('reduce');
        expect(artifact.stage).toBe('compute');
        expect(artifact.backend).toBe('wgsl');
        expect(artifact.code).toContain('@compute @workgroup_size(8, 8, 1)');
        expect(artifact.code).toContain('fn cs_main()');

        expect(compiler.size).toBe(1);
        expect(compiler.has('reduce')).toBe(true);
        expect(compiler.get('reduce')).toBe(artifact);
        expect(compiler.get('missing')).toBeUndefined();
    });

    test('emits expected WGSL for a vertex entry', () => {
        const compiler = new ShaderCompiler({ backend: new WgslBackend() });
        const artifact = compiler.compile(vertexEntry(), 'basic');
        expect(artifact.code).toContain('fn vs_main(@location(0) pos: vec3<f32>)');
        expect(artifact.code).toContain('return vec4<f32>(1.0, 1.0, 1.0, 1.0);');
    });

    test('compileAll compiles every named entry', () => {
        const compiler = new ShaderCompiler({ backend: new WgslBackend() });
        const artifacts = compiler.compileAll([
            { name: 'a', entry: computeEntry() },
            { name: 'b', entry: vertexEntry() },
        ]);
        expect(artifacts.length).toBe(2);
        expect(compiler.size).toBe(2);
        expect(compiler.has('a')).toBe(true);
        expect(compiler.has('b')).toBe(true);
    });

    test('rejects a duplicate name', () => {
        const compiler = new ShaderCompiler({ backend: new WgslBackend() });
        compiler.compile(computeEntry(), 'dup');
        expect(() => compiler.compile(computeEntry(), 'dup')).toThrow();
    });
});

describe('transform', () => {
    test('compiles a DSL builder to backend source', () => {
        const backend = new WgslBackend();
        const artifact = transform(
            'fragment',
            (_v, _m, s) => s.vec4f(s.f32(1), s.f32(0), s.f32(0), s.f32(1)),
            { name: 'tint', backend },
        );

        expect(artifact.name).toBe('tint');
        expect(artifact.stage).toBe('fragment');
        expect(artifact.backend).toBe('wgsl');
        expect(artifact.code).toContain('@fragment');
        expect(artifact.code).toContain('return vec4<f32>(1.0, 0.0, 0.0, 1.0);');
    });

    test('reuses an existing compiler registry', () => {
        const backend = new WgslBackend();
        const compiler = new ShaderCompiler({ backend });
        transform('fragment', (_v, _m, s) => s.vec4f(s.f32(1), s.f32(1), s.f32(1), s.f32(1)), {
            name: 'a', backend, compiler,
        });
        expect(compiler.has('a')).toBe(true);
        expect(() => transform('fragment', (_v, _m, s) => s.f32(0), { name: 'a', backend, compiler }))
            .toThrow();
    });
});

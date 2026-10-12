import { describe, expect, test } from 'bun:test';
import { emitEntry } from '../codegen/emit';
import { TestWgslBackend } from '../codegen/test-syntax';
import { createEmitContext } from '../codegen/backend';
import { breakStmt, call, loopStmt, vec, type IrStmt } from '../ir';
import { parseShaderBody, parseShaderFunction } from './parse';
import { ShaderValue, toExpr, ShaderInput } from '../dsl/value';
import { ShaderCompiler, transformSource } from './transform';

function wgsl(source: string, options: Parameters<typeof parseShaderBody>[1] = { stage: 'fragment' }): string {
    return emitEntry(parseShaderBody(source, options), new TestWgslBackend()).code;
}

function loopEmitSupported(): boolean {
    const backend = new TestWgslBackend();
    return backend.emitNode(loopStmt([breakStmt()]), createEmitContext(backend)).includes('break;');
}

function onlyBody(source: string): IrStmt[] {
    return parseShaderBody(source, { stage: 'fragment' }).body as IrStmt[];
}

function loopAt(body: readonly IrStmt[], index: number): Extract<IrStmt, { kind: 'loop' }> {
    const stmt = body[index]!;
    if (stmt.kind !== 'loop') throw new Error(`expected a loop at ${index}`);
    return stmt;
}

describe('parseShaderBody', () => {
    test('lower an expression body to a fragment return', () => {
        const code = wgsl('(_v, _m, s) => s.vec4f(1, 0, 0, 1)');
        expect(code).toContain('@fragment');
        expect(code).toContain('return vec4<f32>(1, 0, 0, 1);');
    });

    test('a minified destructured helper resolves by its preserved key', () => {
        // Minify keeps object keys but renames bindings: `{ snoise }` becomes
        // `{ snoise: X }`. The helper must resolve by the key, not the binding.
        const helper = (x: unknown) => new ShaderValue({ node: call(vec('f32', 3), 'snoise', [toExpr(x as ShaderInput)]) });
        const code = wgsl('(input, { snoise: X }) => { return X(input.uv); }', {
            stage: 'fragment',
            params: { uv: vec('f32', 2) },
            externals: { snoise: helper },
        } as never);
        expect(code).toContain('snoise');
    });

    test('lowers a minified `if`-as-short-circuit back to an if statement', () => {
        // minifySyntax: `if (c) discard;` -> `c && discard;`
        const code = wgsl('(_v, _m, s) => { s.f32(1) > s.f32(0) && s.discard(); return s.vec4f(1, 1, 1, 1); }');
        expect(code).toContain('if (');
        expect(code).toContain('discard');
    });

    test('lowers a minified statement+return sequence', () => {
        // minifySyntax: `if (c) discard; return v;` -> `return c && discard(), v;`
        const code = wgsl('(_v, _m, s) => { return s.f32(1) > s.f32(0) && s.discard(), s.vec4f(1, 1, 1, 1); }');
        expect(code).toContain('discard');
        expect(code).toContain('return vec4<f32>(');
    });

    test('lowers const declarations and native operators', () => {
        const code = wgsl('(_v, _m, s) => { const a = s.f32(2) * s.f32(3); return s.vec4f(a, a, a, 1); }');
        expect(code).toContain('let');
        expect(code).toContain('return vec4<f32>(');
    });

    test('lowers if / else to structured control flow', () => {
        const code = wgsl(
            '(_v, _m, s) => { if (s.f32(1) > s.f32(0)) { return s.vec4f(1, 0, 0, 1); } else { return s.vec4f(0, 0, 0, 1); } }',
        );
        expect(code).toContain('if (');
        expect(code).toContain('else {');
    });

    test('lower swizzles and std calls', () => {
        const code = wgsl('(_v, _m, s) => { const n = s.normalize(s.vec3f(1, 2, 3)); return s.vec4f(n.x, n.y, n.z, 1); }');
        expect(code).toContain('normalize(');
        expect(code).toContain('.x');
    });

    test('resolves input and material namespaces', () => {
        const code = wgsl('(v, m, s) => s.vec4f(v.uv.x, m.tint.y, 0, 1)', {
            stage: 'fragment',
            params: { uv: { kind: 'vec', scalar: 'f32', width: 2 } },
            material: { tint: { kind: 'vec', scalar: 'f32', width: 3 } },
        });
        expect(code).toContain('@location(0)');
        expect(code).toContain('return vec4<f32>(');
    });

    test('parses a function object via toString', () => {
        const entry = parseShaderFunction(((_v: unknown, _m: unknown, s: { vec4f: (...a: number[]) => unknown }) => s.vec4f(1, 0, 0, 1)) as never, { stage: 'fragment' });
        expect(entry.stage).toBe('fragment');
    });

    test('throws on an unknown identifier', () => {
        expect(() => wgsl('(_v, _m, s) => s.vec4f(unknownThing, 0, 0, 1)')).toThrow();
    });

    test('lowers a for loop to init plus a guarded loop', () => {
        const body = onlyBody(
            '(_v, _m, s) => { for (let i = d.u32(1); i <= d.u32(7); i = i + d.u32(1)) { } return s.vec4f(0, 0, 0, 1); }',
        );
        expect(body[0]!.kind).toBe('let');
        const loop = loopAt(body, 1);
        expect(loop.body[0]!.kind).toBe('if');
        const guard = loop.body[0]!;
        if (guard.kind !== 'if') throw new Error('expected the break guard');
        expect(guard.cond.kind).toBe('unary');
        expect(guard.then[0]!.kind).toBe('break');
        expect(loop.body[loop.body.length - 1]!.kind).toBe('assign');
    });

    test('lowers a while loop to a guarded loop', () => {
        const body = onlyBody(
            '(_v, _m, s) => { while (s.f32(1) > s.f32(0)) { break; } return s.vec4f(0, 0, 0, 1); }',
        );
        const loop = loopAt(body, 0);
        expect(loop.body[0]!.kind).toBe('if');
        expect(loop.body[1]!.kind).toBe('break');
    });

    test('lowers a do loop with a trailing guard', () => {
        const body = onlyBody(
            '(_v, _m, s) => { do { continue; } while (s.f32(1) > s.f32(0)); return s.vec4f(0, 0, 0, 1); }',
        );
        const loop = loopAt(body, 0);
        expect(loop.body[0]!.kind).toBe('continue');
        expect(loop.body[1]!.kind).toBe('if');
        const guard = loop.body[1]!;
        if (guard.kind !== 'if') throw new Error('expected the break guard');
        expect(guard.then[0]!.kind).toBe('break');
    });

    test('lowers d casts to cast nodes', () => {
        const body = onlyBody('(_v, _m, s) => d.u32(s.f32(1))');
        const stmt = body[0]!;
        if (stmt.kind !== 'return') throw new Error('expected a return');
        if (stmt.value?.kind !== 'cast') throw new Error('expected a cast');
        expect(stmt.value.type).toEqual({ kind: 'scalar', scalar: 'u32' });
    });

    test.skipIf(!loopEmitSupported())('compiles a for loop when the emitter supports it', () => {
        const code = wgsl(
            '(_v, _m, s) => { for (let i = d.u32(1); i <= d.u32(7); i = i + d.u32(1)) { } return s.vec4f(0, 0, 0, 1); }',
        );
        expect(code).toContain('loop {');
        expect(code).toContain('break;');
    });
});

describe('transformSource', () => {
    test('parses source and compiles it', () => {
        const compiler = new ShaderCompiler({ backend: new TestWgslBackend() });
        const artifact = transformSource('(_v, _m, s) => s.vec4f(0, 1, 0, 1)', {
            stage: 'fragment',
            name: 'green',
            backend: compiler.backend,
            compiler,
        });
        expect(artifact.name).toBe('green');
        expect(artifact.code).toContain('return vec4<f32>(0, 1, 0, 1);');
        expect(compiler.has('green')).toBe(true);
    });
});

import { test, expect, describe } from 'bun:test';
import {
    access,
    binding,
    binary,
    builtin,
    call,
    cast,
    construct,
    discardStmt,
    entry,
    ifStmt,
    letStmt,
    literal,
    local,
    param,
    returnStmt,
    sample,
} from '../ir/builders';
import { array, bool, f32, field, i32, mat, sampler, struct, texture, u32, vec } from '../ir/types';
import { createEmitContext } from './backend';
import { emitEntry } from './emit';
import { GlslBackend } from './glsl';

function glsl(): GlslBackend {
    return new GlslBackend();
}

describe('GlslBackend', () => {
    test('advertises the portable subset only', () => {
        const backend = glsl();
        expect(backend.name).toBe('glsl');
        expect(backend.capabilities).toEqual({
            compute: false,
            storageBuffers: false,
            f16: false,
            subgroups: false,
        });
    });
});

describe('emitEntry', () => {
    test('emits a vertex entry with inputs and gl_Position', () => {
        const vertex = entry({
            stage: 'vertex',
            params: [param('pos', vec('f32', 3), 0)],
            body: [
                returnStmt(
                    construct(vec('f32', 4), [
                        literal(f32(), 0),
                        literal(f32(), 0),
                        literal(f32(), 0),
                        literal(f32(), 1),
                    ]),
                ),
            ],
        });

        const result = emitEntry(vertex, glsl());
        expect(result.stage).toBe('vertex');
        expect(result.code).toBe(
            [
                '#version 300 es',
                'precision highp float;',
                'precision highp int;',
                'layout(location = 0) in vec3 pos;',
                'void main() {',
                '    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);',
                '}',
            ].join('\n'),
        );
    });

    test('emits a fragment entry with a builtin, if/else, discard, and out', () => {
        const fragment = entry({
            stage: 'fragment',
            params: [],
            body: [
                letStmt(1, f32(), access(f32(), builtin(vec('f32', 4), 'frag_coord'), 'x')),
                ifStmt(
                    binary(bool(), '>', local(f32(), 1), literal(f32(), 0.5)),
                    [
                        returnStmt(
                            construct(vec('f32', 4), [
                                literal(f32(), 1),
                                literal(f32(), 1),
                                literal(f32(), 1),
                                literal(f32(), 1),
                            ]),
                        ),
                    ],
                    [discardStmt()],
                ),
                returnStmt(
                    construct(vec('f32', 4), [
                        literal(f32(), 0),
                        literal(f32(), 0),
                        literal(f32(), 0),
                        literal(f32(), 1),
                    ]),
                ),
            ],
        });

        const result = emitEntry(fragment, glsl());
        expect(result.entryName).toBe('fs_main');
        expect(result.code).toBe(
            [
                '#version 300 es',
                'precision highp float;',
                'precision highp int;',
                'out vec4 fragColor;',
                'void main() {',
                '    float v1 = gl_FragCoord.x;',
                '    if ((v1 > 0.5)) {',
                '        fragColor = vec4(1.0, 1.0, 1.0, 1.0);',
                '    } else {',
                '        discard;',
                '    }',
                '    fragColor = vec4(0.0, 0.0, 0.0, 1.0);',
                '}',
            ].join('\n'),
        );
    });

    test('emits a uniform block and merges texture with sampler', () => {
        const uniforms = struct('Uniforms', [field('mvp', mat('f32', 4, 4))]);
        const tex = texture('f32', '2d', 'sample');
        const backend = new GlslBackend({ structs: [uniforms] });
        const fragment = entry({
            stage: 'fragment',
            params: [],
            body: [
                returnStmt(
                    binary(
                        vec('f32', 4),
                        '+',
                        access(vec('f32', 4), binding(uniforms, 0, 0), 'mvp'),
                        sample(
                            vec('f32', 4),
                            binding(tex, 0, 1),
                            binding(sampler(), 0, 2),
                            literal(vec('f32', 2), [0.25, 0.75]),
                        ),
                    ),
                ),
            ],
        });

        const code = emitEntry(fragment, backend).code;
        expect(code).toContain('struct Uniforms {\n    mat4 mvp;\n};');
        expect(code).toContain('layout(std140) uniform binding_0_0 {\n    mat4 mvp;\n};');
        expect(code).toContain('uniform sampler2D binding_0_1;');
        expect(code).not.toContain('binding_0_2');
        expect(code).toContain(
            'fragColor = (binding_0_0.mvp + texture(binding_0_1, vec2(0.25, 0.75)));',
        );
    });
});

describe('declareBinding', () => {
    test('emits uniform declarations and drops samplers', () => {
        const backend = glsl();
        const ctx = createEmitContext(backend);
        expect(backend.declareBinding(binding(mat('f32', 4, 4), 0, 0), ctx)).toBe(
            'uniform mat4 binding_0_0;',
        );
        expect(backend.declareBinding(binding(texture('f32', '2d', 'sample'), 0, 1), ctx)).toBe(
            'uniform sampler2D binding_0_1;',
        );
        expect(backend.declareBinding(binding(sampler(), 0, 2), ctx)).toBe('');
    });
});

describe('mapBuiltin', () => {
    test('maps builtins to their GLSL variables', () => {
        const backend = glsl();
        const ctx = createEmitContext(backend);
        expect(backend.mapBuiltin(builtin(vec('f32', 4), 'position'), ctx)).toBe('gl_Position');
        expect(backend.mapBuiltin(builtin(vec('f32', 4), 'frag_coord'), ctx)).toBe('gl_FragCoord');
        expect(backend.mapBuiltin(builtin(bool(), 'front_facing'), ctx)).toBe('gl_FrontFacing');
        expect(backend.mapBuiltin(builtin(vec('u32', 3), 'instance_index'), ctx)).toBe(
            'gl_InstanceID',
        );
    });
});

describe('expression emission', () => {
    test('emits GLSL literals, casts, and intrinsics', () => {
        const backend = glsl();
        const ctx = createEmitContext(backend);
        ctx.scopes.define(9, 'v9');

        expect(backend.emitNode(literal(f32(), 2), ctx)).toBe('2.0');
        expect(backend.emitNode(literal(i32(), 3), ctx)).toBe('3');
        expect(backend.emitNode(literal(u32(), 3), ctx)).toBe('3u');
        expect(backend.emitNode(literal(vec('f32', 3), [1, 2, 3]), ctx)).toBe(
            'vec3(1.0, 2.0, 3.0)',
        );
        expect(backend.emitNode(cast(f32(), literal(i32(), 3)), ctx)).toBe('float(3)');
        expect(backend.emitNode(cast(u32(), literal(f32(), 3)), ctx)).toBe('uint(3.0)');
        expect(
            backend.emitNode(call(f32(), 'mod', [literal(f32(), 5), literal(f32(), 2)]), ctx),
        ).toBe('mod(5.0, 2.0)');
        expect(backend.emitNode(call(f32(), 'fract', [local(f32(), 9)]), ctx)).toBe('fract(v9)');
        expect(backend.emitNode(call(f32(), 'inverseSqrt', [literal(f32(), 4)]), ctx)).toBe(
            'inversesqrt(4.0)',
        );
        expect(backend.emitNode(call(vec('f32', 3), 'normalize', [local(vec('f32', 3), 9)]), ctx)).toBe(
            'normalize(v9)',
        );
    });
});

describe('unsupported constructs', () => {
    test('compute throws', () => {
        const compute = entry({
            stage: 'compute',
            params: [],
            workgroupSize: [8, 8, 1],
            body: [returnStmt(null)],
        });
        expect(() => emitEntry(compute, glsl())).toThrow(/compute/);
    });

    test('storage buffers throw', () => {
        const body = [
            returnStmt(access(f32(), binding(array(f32(), null), 1, 2), literal(u32(), 0))),
        ];
        const vertex = entry({ stage: 'vertex', params: [], body });
        expect(() => emitEntry(vertex, glsl())).toThrow(/storage/);
    });
});

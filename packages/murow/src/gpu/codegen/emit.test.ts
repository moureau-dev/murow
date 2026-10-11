import { test, expect, describe } from 'bun:test';
import {
    access,
    assignStmt,
    binding,
    binary,
    breakStmt,
    builtin,
    call,
    cast,
    construct,
    continueStmt,
    discardStmt,
    entry,
    ifStmt,
    letStmt,
    literal,
    local,
    loopStmt,
    param,
    returnStmt,
    sample,
    swizzle,
    unary,
} from '../ir/builders';
import { array, bool, f32, field, i32, mat, sampler, struct, texture, u32, vec } from '../ir/types';
import { createEmitContext } from './backend';
import { emitEntry } from './emit';
import { TestWgslBackend } from './test-syntax';

function wgsl(): TestWgslBackend {
    return new TestWgslBackend();
}

describe('TestWgslBackend', () => {
    test('advertises all capabilities', () => {
        const backend = wgsl();
        expect(backend.name).toBe('wgsl');
        expect(backend.capabilities).toEqual({
            compute: true,
            storageBuffers: true,
            f16: true,
            subgroups: true,
        });
    });
});

describe('emitEntry', () => {
    test('emits a vertex entry with a struct preamble and binding', () => {
        const uniforms = struct('Uniforms', [field('mvp', mat('f32', 4, 4))]);
        const backend = new TestWgslBackend({ structs: [uniforms] });
        const vertex = entry({
            stage: 'vertex',
            params: [param('pos', vec('f32', 3), 0)],
            body: [
                letStmt(
                    0,
                    vec('f32', 4),
                    access(vec('f32', 4), binding(uniforms, 0, 0), literal(u32(), 0)),
                ),
                returnStmt(local(vec('f32', 4), 0)),
            ],
        });

        const result = emitEntry(vertex, backend);
        expect(result.stage).toBe('vertex');
        expect(result.entryName).toBe('vs_main');
        expect(result.code).toBe(
            [
                'struct Uniforms {',
                '    mvp: mat4x4<f32>,',
                '}',
                '@group(0) @binding(0) var<uniform> binding_0_0: Uniforms;',
                '@vertex',
                'fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {',
                '    let v0: vec4<f32> = binding_0_0[0u];',
                '    return v0;',
                '}',
            ].join('\n'),
        );
    });

    test('emits a fragment entry with a builtin, if/else, and discard', () => {
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

        const result = emitEntry(fragment, wgsl());
        expect(result.entryName).toBe('fs_main');
        expect(result.code).toBe(
            [
                '@fragment',
                'fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {',
                '    let v1: f32 = frag_coord.x;',
                '    if ((v1 > 0.5)) {',
                '        return vec4<f32>(1.0, 1.0, 1.0, 1.0);',
                '    } else {',
                '        discard;',
                '    }',
                '    return vec4<f32>(0.0, 0.0, 0.0, 1.0);',
                '}',
            ].join('\n'),
        );
    });

    test('emits a compute signature with a workgroup size', () => {
        const backend = wgsl();
        const compute = entry({
            stage: 'compute',
            params: [],
            workgroupSize: [8, 8, 1],
            body: [returnStmt(null)],
        });
        const result = emitEntry(compute, backend);
        expect(result.entryName).toBe('cs_main');
        expect(result.code).toContain('@compute @workgroup_size(8, 8, 1)');
        expect(result.code).toContain('fn cs_main()');
    });
});

describe('declareBinding', () => {
    test('emits uniform, texture, and storage declarations', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        expect(backend.declareBinding(binding(mat('f32', 4, 4), 0, 0), ctx)).toBe(
            '@group(0) @binding(0) var<uniform> binding_0_0: mat4x4<f32>;',
        );
        expect(backend.declareBinding(binding(texture('f32', '2d', 'sample'), 0, 1), ctx)).toBe(
            '@group(0) @binding(1) var binding_0_1: texture_2d<f32>;',
        );
        expect(backend.declareBinding(binding(array(f32(), null), 1, 2), ctx)).toBe(
            '@group(1) @binding(2) var<storage> binding_1_2: array<f32>;',
        );
    });
});

describe('mapBuiltin', () => {
    test('maps the default builtins', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        expect(backend.mapBuiltin(builtin(vec('f32', 4), 'position'), ctx)).toBe('@builtin(position)');
        expect(backend.mapBuiltin(builtin(vec('f32', 4), 'frag_coord'), ctx)).toBe('@builtin(position)');
        expect(backend.mapBuiltin(builtin(bool(), 'front_facing'), ctx)).toBe('@builtin(front_facing)');
        expect(backend.mapBuiltin(builtin(vec('u32', 3), 'invocation_id'), ctx)).toBe(
            '@builtin(global_invocation_id)',
        );
    });
});

describe('expression emission', () => {
    test('emits every expression kind', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        ctx.scopes.define(9, 'v9');

        expect(backend.emitNode(literal(f32(), 2), ctx)).toBe('2.0');
        expect(backend.emitNode(literal(i32(), 3), ctx)).toBe('3');
        expect(backend.emitNode(literal(u32(), 3), ctx)).toBe('3u');
        expect(backend.emitNode(literal(bool(), true), ctx)).toBe('true');
        expect(backend.emitNode(literal(vec('f32', 3), [1, 2, 3]), ctx)).toBe(
            'vec3<f32>(1.0, 2.0, 3.0)',
        );
        expect(backend.emitNode(local(f32(), 9), ctx)).toBe('v9');
        expect(backend.emitNode(binding(f32(), 0, 2), ctx)).toBe('binding_0_2');
        expect(backend.emitNode(builtin(vec('f32', 4), 'frag_coord'), ctx)).toBe('frag_coord');
        expect(backend.emitNode(unary(f32(), '-', literal(f32(), 1)), ctx)).toBe('(-1.0)');
        expect(backend.emitNode(binary(f32(), '+', literal(f32(), 1), literal(f32(), 2)), ctx)).toBe(
            '(1.0 + 2.0)',
        );
        expect(backend.emitNode(construct(vec('f32', 4), [literal(f32(), 1)]), ctx)).toBe(
            'vec4<f32>(1.0)',
        );
        expect(backend.emitNode(swizzle(local(vec('f32', 4), 9), 'xyz'), ctx)).toBe('v9.xyz');
        expect(
            backend.emitNode(access(f32(), binding(struct('S', []), 0, 0), 'foo'), ctx),
        ).toBe('binding_0_0.foo');
        expect(backend.emitNode(access(f32(), local(vec('f32', 4), 9), literal(u32(), 2)), ctx)).toBe(
            'v9[2u]',
        );
        expect(backend.emitNode(call(f32(), 'customFn', [literal(f32(), 1)]), ctx)).toBe(
            'customFn(1.0)',
        );
        expect(backend.emitNode(call(vec('f32', 3), 'normalize', [local(vec('f32', 3), 9)]), ctx)).toBe(
            'normalize(v9)',
        );
        expect(
            backend.emitNode(
                sample(
                    vec('f32', 4),
                    binding(texture('f32', '2d', 'sample'), 0, 0),
                    binding(sampler(), 0, 1),
                    local(vec('f32', 2), 9),
                ),
                ctx,
            ),
        ).toBe('textureSample(binding_0_0, binding_0_1, v9)');
    });
});

describe('extension points', () => {
    test('node registry overrides emission for a kind', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        backend.nodes.register('literal', () => 'CUSTOM');
        expect(backend.emitNode(literal(f32(), 1), ctx)).toBe('CUSTOM');
    });

    test('intrinsic registry overrides a default intrinsic', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        backend.intrinsics.override('normalize', () => 'customNormalize()');
        expect(backend.emitNode(call(vec('f32', 3), 'normalize', [local(vec('f32', 3), 0)]), ctx)).toBe(
            'customNormalize()',
        );
    });
});

describe('loop control flow', () => {
    test('emits loop, break, continue, and assignment', () => {
        const compute = entry({
            stage: 'compute',
            params: [],
            workgroupSize: [1, 1, 1],
            body: [
                loopStmt([
                    letStmt(0, u32(), literal(u32(), 0)),
                    ifStmt(
                        binary(bool(), '>=', local(u32(), 0), literal(u32(), 10)),
                        [breakStmt()],
                    ),
                    assignStmt(
                        local(u32(), 0),
                        binary(u32(), '+', local(u32(), 0), literal(u32(), 1)),
                    ),
                    continueStmt(),
                ]),
                returnStmt(null),
            ],
        });

        const result = emitEntry(compute, wgsl());
        expect(result.code).toBe(
            [
                '@compute @workgroup_size(1, 1, 1)',
                'fn cs_main() {',
                '    loop {',
                '        let v0: u32 = 0u;',
                '        if ((v0 >= 10u)) {',
                '            break;',
                '        }',
                '        v0 = (v0 + 1u);',
                '        continue;',
                '    }',
                '    return;',
                '}',
            ].join('\n'),
        );
    });
});

describe('cast emission', () => {
    test('emits the target type as a conversion call', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        ctx.scopes.define(9, 'v9');

        expect(backend.emitNode(cast(u32(), literal(f32(), 3)), ctx)).toBe('u32(3.0)');
        expect(backend.emitNode(cast(f32(), cast(i32(), local(f32(), 9))), ctx)).toBe('f32(i32(v9))');
        expect(
            backend.emitNode(
                binary(f32(), '+', cast(f32(), literal(i32(), 2)), literal(f32(), 1)),
                ctx,
            ),
        ).toBe('(f32(2) + 1.0)');
    });
});

describe('binding kinds', () => {
    test('declares textures and samplers under their hint names', () => {
        const backend = new TestWgslBackend({
            bindings: [
                { group: 0, binding: 0, kind: 'texture', name: 'albedo' },
                { group: 0, binding: 1, kind: 'sampler', name: 'albedoSampler' },
            ],
        });
        const ctx = createEmitContext(backend);
        expect(backend.declareBinding(binding(texture('f32', '2d', 'sample'), 0, 0), ctx)).toBe(
            '@group(0) @binding(0) var albedo: texture_2d<f32>;',
        );
        expect(backend.declareBinding(binding(sampler(), 0, 1), ctx)).toBe(
            '@group(0) @binding(1) var albedoSampler: sampler;',
        );
    });

    test('renders hint names in access chains and samples', () => {
        const backend = new TestWgslBackend({
            bindings: [
                { group: 0, binding: 0, kind: 'texture', name: 'albedo' },
                { group: 0, binding: 1, kind: 'sampler', name: 'albedoSampler' },
            ],
        });
        const ctx = createEmitContext(backend);
        ctx.scopes.define(9, 'v9');
        expect(
            backend.emitNode(
                sample(
                    vec('f32', 4),
                    binding(texture('f32', '2d', 'sample'), 0, 0),
                    binding(sampler(), 0, 1),
                    local(vec('f32', 2), 9),
                ),
                ctx,
            ),
        ).toBe('textureSample(albedo, albedoSampler, v9)');
    });

    test('infers storage for arrays and uniform for structs', () => {
        const light = struct('Light', [field('intensity', f32())]);
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        expect(backend.declareBinding(binding(array(light, null), 0, 0), ctx)).toBe(
            '@group(0) @binding(0) var<storage> binding_0_0: array<Light>;',
        );
        expect(backend.declareBinding(binding(light, 0, 1), ctx)).toBe(
            '@group(0) @binding(1) var<uniform> binding_0_1: Light;',
        );
    });

    test('emits explicit storage access modes', () => {
        const light = struct('Light', [field('intensity', f32())]);
        const backend = new TestWgslBackend({
            bindings: [
                { group: 0, binding: 0, kind: 'storage', name: 'lights', access: 'read_write' },
                { group: 0, binding: 1, kind: 'storage', name: 'readonly', access: 'read' },
            ],
        });
        const ctx = createEmitContext(backend);
        expect(backend.declareBinding(binding(array(light, null), 0, 0), ctx)).toBe(
            '@group(0) @binding(0) var<storage, read_write> lights: array<Light>;',
        );
        expect(backend.declareBinding(binding(array(light, null), 0, 1), ctx)).toBe(
            '@group(0) @binding(1) var<storage, read> readonly: array<Light>;',
        );
    });

    test('emits struct declarations discovered from bindings', () => {
        const light = struct('Light', [field('pos', vec('f32', 3)), field('intensity', f32())]);
        const backend = new TestWgslBackend({
            bindings: [{ group: 0, binding: 0, kind: 'storage', name: 'lights', access: 'read_write' }],
        });
        const compute = entry({
            stage: 'compute',
            params: [],
            workgroupSize: [1, 1, 1],
            body: [
                letStmt(
                    0,
                    f32(),
                    access(
                        f32(),
                        access(light, binding(array(light, null), 0, 0), literal(u32(), 1)),
                        'intensity',
                    ),
                ),
                returnStmt(local(f32(), 0)),
            ],
        });

        const result = emitEntry(compute, backend);
        expect(result.code).toContain('struct Light {');
        expect(result.code).toContain('    pos: vec3<f32>,');
        expect(result.code).toContain(
            '@group(0) @binding(0) var<storage, read_write> lights: array<Light>;',
        );
        expect(result.code).toContain('let v0: f32 = lights[1u].intensity;');
    });

    test('emits a builtin-indexed field access', () => {
        const light = struct('Light', [field('intensity', f32())]);
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        expect(
            backend.emitNode(
                access(
                    f32(),
                    access(light, builtin(array(light, null), 'lights'), literal(u32(), 1)),
                    'intensity',
                ),
                ctx,
            ),
        ).toBe('lights[1u].intensity');
    });
});

describe('preamble injection', () => {
    test('includes injected helpers ahead of the entry point', () => {
        const backend = new TestWgslBackend({ helpers: 'fn noise(p: vec2<f32>) -> f32 { return 0.0; }' });
        backend.addPreamble('fn tonemap(c: vec3<f32>) -> vec3<f32> { return c; }');
        const compute = entry({
            stage: 'compute',
            params: [],
            workgroupSize: [1, 1, 1],
            body: [returnStmt(null)],
        });

        const code = emitEntry(compute, backend).code;
        expect(code).toContain('fn noise(p: vec2<f32>) -> f32 { return 0.0; }');
        expect(code).toContain('fn tonemap(c: vec3<f32>) -> vec3<f32> { return c; }');
        expect(code.indexOf('fn noise')).toBeLessThan(code.indexOf('@compute'));
    });

    test('emits struct declarations before injected helpers', () => {
        const light = struct('Light', [field('intensity', f32())]);
        const backend = new TestWgslBackend({ structs: [light], helpers: 'fn lightContribution() {}' });
        const compute = entry({
            stage: 'compute',
            params: [],
            workgroupSize: [1, 1, 1],
            body: [returnStmt(null)],
        });

        const code = emitEntry(compute, backend).code;
        expect(code.indexOf('struct Light')).toBeLessThan(code.indexOf('fn lightContribution'));
    });
});

describe('composite literals', () => {
    test('emits array literals and array-of-struct constructors', () => {
        const backend = wgsl();
        const ctx = createEmitContext(backend);
        expect(backend.emitNode(literal(array(f32(), 2), [1, 2]), ctx)).toBe(
            'array<f32, 2>(1.0, 2.0)',
        );

        const light = struct('Light', [field('intensity', f32())]);
        expect(
            backend.emitNode(
                construct(array(light, 2), [
                    construct(light, [literal(f32(), 1)]),
                    construct(light, [literal(f32(), 2)]),
                ]),
                ctx,
            ),
        ).toBe('array<Light, 2>(Light(1.0), Light(2.0))');
    });
});

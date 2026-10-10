import { describe, expect, test } from 'bun:test';
import { emitEntry } from './codegen/emit';
import { TestWgslBackend } from './codegen/test-syntax';
import { transformSource } from './compiler/transform';
import { noise, scene, textures } from './dsl/externals';
import { shader } from './dsl/entry';
import { d } from './dsl/data';
import { f32 as f32Type, vec } from './ir/types';

const backend = new TestWgslBackend();
const V2 = vec('f32', 2);
const V3 = vec('f32', 3);

describe('murow/gpu can express engine shaders (eager DSL)', () => {
    test('glow: uniforms + varying + std math', () => {
        const glow = shader.fragment(
            { params: { vUV: V2 }, material: { time: f32Type(), tint: V3 } },
            (input, material, std) => {
                const dx = std.sub(input.vUV.x, d.f32(0.5));
                const dy = std.sub(input.vUV.y, d.f32(0.5));
                const dist = std.mul(std.length(std.vec2f(dx, dy)), d.f32(2));
                const pulse = std.add(d.f32(0.7), std.mul(d.f32(0.3), std.sin(std.mul(material.time, d.f32(9)))));
                const i = std.mul(std.pow(std.saturate(std.sub(d.f32(1), dist)), d.f32(2.5)), pulse);
                return std.vec4f(
                    std.mul(material.tint.x, i),
                    std.mul(material.tint.y, i),
                    std.mul(material.tint.z, i),
                    d.f32(1),
                );
            },
        );
        const code = emitEntry(glow, backend).code;
        expect(code).toContain('@fragment');
        expect(code).toContain('sin(');
        expect(code).toContain('pow(');
        expect(code).toContain('return vec4<f32>(');
    });

    test('shield: scene uniforms + fresnel', () => {
        const shield = shader.fragment(
            { params: { vNormal: V3, vWorldPos: V3 }, material: { time: f32Type(), intensity: f32Type() } },
            (v, m, s) => {
                const n = s.normalize(v.vNormal);
                const toCam = s.normalize(
                    s.vec3f(
                        s.sub(scene.cameraX, v.vWorldPos.x),
                        s.sub(scene.cameraY, v.vWorldPos.y),
                        s.sub(scene.cameraZ, v.vWorldPos.z),
                    ),
                );
                const fres = s.pow(s.sub(d.f32(1), s.abs(s.dot(n, toCam))), d.f32(2.2));
                const band = s.add(
                    d.f32(0.5),
                    s.mul(d.f32(0.5), s.sin(s.sub(s.mul(v.vWorldPos.y, d.f32(26)), s.mul(m.time, d.f32(6))))),
                );
                const i = s.mul(s.add(s.mul(fres, d.f32(1.4)), s.mul(band, d.f32(0.12))), m.intensity);
                return s.vec4f(i, i, i, d.f32(1));
            },
        );
        const code = emitEntry(shield, backend).code;
        expect(code).toContain('normalize(');
        expect(code).toContain('return vec4<f32>(');
    });

    test('noise helper is a callable intrinsic', () => {
        const frag = shader.fragment({ params: { vUV: V2 } }, (v, _m, s) => {
            const n = s.abs(noise(s.vec3f(v.vUV.x, v.vUV.y, d.f32(0))));
            return s.vec4f(n, n, n, d.f32(1));
        });
        expect(emitEntry(frag, backend).code).toContain('noise(');
    });

    test('named textures sample', () => {
        const frag = shader.fragment({ params: { vUV: V2 } }, (v, _m, s) =>
            s.textureSample(textures.map, textures.mapSampler, v.vUV),
        );
        expect(emitEntry(frag, backend).code).toContain('textureSample(');
    });
});

describe('murow/gpu can express engine shaders (parser front-end)', () => {
    test('a for loop lowers to loop + break', () => {
        const artifact = transformSource(
            '(_v, _m, s) => { let acc = 0; for (let i = 0; i < 4; i = i + 1) { acc = acc + i; } return s.vec4f(acc, acc, acc, 1); }',
            { stage: 'fragment', name: 'loopTest', backend },
        );
        expect(artifact.code).toContain('loop {');
        expect(artifact.code).toContain('break;');
    });

    test('while loop lowers to loop + break', () => {
        const artifact = transformSource(
            '(_v, _m, s) => { let n = 0; while (n < 3) { n = n + 1; } return s.vec4f(n, n, n, 1); }',
            { stage: 'fragment', name: 'whileTest', backend },
        );
        expect(artifact.code).toContain('loop {');
        expect(artifact.code).toContain('break;');
    });
});

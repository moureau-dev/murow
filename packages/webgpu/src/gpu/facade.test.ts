import { describe, expect, test } from 'bun:test';
import { lightContribution, tonemap } from 'murow/gpu/dsl';
import { d } from './data';
import { handleView } from './environment';
import { std } from './std';
import { tgpu } from './tgpu';

describe('facade shader lowering', () => {
    test('fragment body lowers with a material uniform, varying, and std math', () => {
        const materialStruct = d.struct({ time: d.f32, tint: d.vec3f });
        const matLayout = tgpu.bindGroupLayout({ material: { uniform: materialStruct } });

        const fn = function (input: { vUV: { x: number; y: number } }) {
            const time = (matLayout.$ as any).material.time;
            const uv = input.vUV;
            const dx = uv.x - 0.5;
            const dy = uv.y - 0.5;
            const dist = std.mul(std.length(std.vec2f(dx, dy)), 2.0);
            const pulse = std.add(0.7, std.mul(0.3, std.sin(time * 9.0)));
            const i = std.mul(std.pow(std.saturate(std.sub(1.0, dist)), 2.5), pulse);
            return d.vec4f(i, i, i, 1.0);
        };

        const fragment = tgpu.fragmentFn({
            in: { vUV: d.vec2f },
            out: d.vec4f,
            externals: { matLayout: handleView(matLayout, 1) },
        })(fn);

        const code = tgpu.resolveWithContext([fragment]).code;
        expect(code).toContain('@fragment');
        expect(code).toContain('fn fs_main(@location(0) vUV: vec2<f32>) -> @location(0) vec4<f32>');
        expect(code).toContain('@group(1) @binding(0) var<uniform> binding_1_0');
        expect(code).toContain('sin(');
        expect(code).toContain('pow(');
        expect(code).toContain('return vec4<f32>(');
    });

    test('mesh vertex lowers inputs, builtins, storage reads, and outputs', () => {
        const MeshUniforms = d.struct({ viewProjection: d.mat4x4f, alpha: d.f32 });
        const DynamicMesh = d.struct({ currPosX: d.f32, currPosY: d.f32, currPosZ: d.f32 });
        const StaticMesh = d.struct({ colorR: d.f32, colorG: d.f32, colorB: d.f32 });
        const meshLayout = tgpu.bindGroupLayout({
            uniforms: { uniform: MeshUniforms },
            dynamicInstances: { storage: d.arrayOf(DynamicMesh, 8) },
            staticInstances: { storage: d.arrayOf(StaticMesh, 8) },
            slotIndices: { storage: d.arrayOf(d.u32, 8) },
        });

        const fn = function (input: {
            position: { x: number; y: number; z: number };
            instanceIndex: number;
        }) {
            const slot = (meshLayout.$ as any).slotIndices[input.instanceIndex];
            const dyn = (meshLayout.$ as any).dynamicInstances[slot];
            const stat = (meshLayout.$ as any).staticInstances[slot];
            const vp = (meshLayout.$ as any).uniforms.viewProjection;
            const world = d.vec4f(input.position.x + dyn.currPosX, input.position.y + dyn.currPosY, input.position.z + dyn.currPosZ, 1.0);
            const clip = vp * world;
            return {
                pos: clip,
                vColor: d.vec3f(stat.colorR, stat.colorG, stat.colorB),
            };
        };

        const vertex = tgpu.vertexFn({
            in: {
                position: d.location(0, d.vec3f),
                instanceIndex: d.builtin.instanceIndex,
            },
            out: {
                pos: d.builtin.position,
                vColor: d.vec3f,
            },
            externals: { meshLayout: handleView(meshLayout, 0) },
        })(fn);

        const code = tgpu.resolveWithContext([vertex]).code;
        expect(code).toContain('@vertex');
        expect(code).toContain('@location(0) position: vec3<f32>');
        expect(code).toContain('@builtin(instance_index) instance_index: u32');
        expect(code).toContain('struct vs_out');
        expect(code).toContain('@builtin(position) pos: vec4<f32>');
        expect(code).toContain('@location(0) vColor: vec3<f32>');
        expect(code).toContain('return vs_out(');
    });

    test('engine helper functions are injected only when called', () => {
        const fn = function (input: { vUV: { x: number; y: number } }) {
            const uv = input.vUV;
            const n = std.abs(d.f32(0.0));
            return d.vec4f(uv.x, uv.y, n, 1.0);
        };
        const fragment = tgpu.fragmentFn({ in: { vUV: d.vec2f }, out: d.vec4f })(fn);
        const code = tgpu.resolveWithContext([fragment]).code;
        expect(code).not.toContain('fn noise(');
        expect(code).not.toContain('fn tonemap(');
    });

    test('a light loop lowers and injects lightContribution and tonemap', () => {
        const fn = function (input: any) {
            let acc = d.vec3f(0.0, 0.0, 0.0);
            for (let i = d.u32(0); i < d.u32(2); i++) {
                const c = lightContribution(
                    input.vWorldPos,
                    input.vNormal,
                    input.vColor,
                    d.vec4f(1.0, 1.0, 1.0, 1.0),
                    input.vNormal,
                    input.vWorldPos,
                );
                acc = d.vec3f(acc.x + c.x, acc.y + c.y, acc.z + c.z);
            }
            const mapped = tonemap(acc);
            return d.vec4f(mapped.x, mapped.y, mapped.z, 1.0);
        };
        const fragment = tgpu.fragmentFn({
            in: { vNormal: d.vec3f, vColor: d.vec3f, vWorldPos: d.vec3f },
            out: d.vec4f,
            externals: { lightContribution, tonemap },
        })(fn);

        const code = tgpu.resolveWithContext([fragment]).code;
        expect(code).toContain('loop {');
        expect(code).toContain('break;');
        expect(code).toContain('fn lightContribution(');
        expect(code).toContain('fn tonemap(');
    });

    test('vertex and fragment share one module without duplicate bindings', () => {
        const Uniforms = d.struct({ viewProjection: d.mat4x4f });
        const meshLayout = tgpu.bindGroupLayout({ uniforms: { uniform: Uniforms } });
        const view = { meshLayout: handleView(meshLayout, 0) };

        const vertex = tgpu.vertexFn({
            in: { position: d.location(0, d.vec3f) },
            out: { pos: d.builtin.position, vColor: d.vec3f },
            externals: view,
        })(function (input: any) {
            const clip = (meshLayout.$ as any).uniforms.viewProjection * d.vec4f(input.position.x, input.position.y, input.position.z, 1.0);
            return { pos: clip, vColor: d.vec3f(1.0, 1.0, 1.0) };
        });

        const fragment = tgpu.fragmentFn({
            in: { vColor: d.vec3f },
            out: d.vec4f,
            externals: view,
        })(function (input: { vColor: { x: number; y: number; z: number } }) {
            return d.vec4f(input.vColor.x, input.vColor.y, input.vColor.z, 1.0);
        });

        const code = tgpu.resolveWithContext([vertex, fragment]).code;
        expect(code.match(/@group\(0\) @binding\(0\)/g)?.length).toBe(1);
        expect(code.match(/struct vs_out/g)?.length).toBe(1);
        expect(code).toContain('fn vs_main(');
        expect(code).toContain('fn fs_main(');
    });
});

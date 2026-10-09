import { describe, expect, test } from 'bun:test';
import { std } from './std';
import { ShaderValue } from './value';
import { binding, local } from '../ir/builders';
import type { IrCall, IrSample } from '../ir/nodes';
import { bool, f32, sampler, texture, vec } from '../ir/types';

const f = f32();
const v3 = vec('f32', 3);
const v4 = vec('f32', 4);

function scalar(id = 0): ShaderValue {
    return new ShaderValue({ node: local(f, id) });
}

function vec3(id = 0): ShaderValue {
    return new ShaderValue({ node: local(v3, id) });
}

describe('std arithmetic', () => {
    test('add/sub/mul/div build calls with the combined type', () => {
        expect((std.add(scalar(0), scalar(1)).node as IrCall).name).toBe('add');
        expect((std.sub(scalar(), scalar()).node as IrCall).name).toBe('sub');
        expect((std.mul(scalar(), scalar()).node as IrCall).name).toBe('mul');
        expect((std.div(scalar(), scalar()).node as IrCall).name).toBe('div');
        expect(std.mul(scalar(), vec3()).type).toEqual(v3);
    });

    test('neg builds a call preserving type', () => {
        const node = std.neg(vec3()).node as IrCall;
        expect(node.name).toBe('neg');
        expect(node.type).toEqual(v3);
    });
});

describe('std vector math', () => {
    test('dot returns a scalar', () => {
        const node = std.dot(vec3(0), vec3(1)).node as IrCall;
        expect(node.name).toBe('dot');
        expect(node.type).toEqual(f);
    });

    test('cross returns a vec3', () => {
        expect(std.cross(vec3(0), vec3(1)).type).toEqual(v3);
    });

    test('normalize preserves type and length returns a scalar', () => {
        expect(std.normalize(vec3()).type).toEqual(v3);
        expect(std.length(vec3()).type).toEqual(f);
    });

    test('mix and clamp', () => {
        expect((std.mix(scalar(), scalar(), scalar()).node as IrCall).name).toBe('mix');
        expect((std.clamp(scalar(), scalar(), scalar()).node as IrCall).name).toBe('clamp');
    });

    test('min/max/pow/sin/cos/abs/floor/fract', () => {
        for (const name of ['min', 'max', 'pow'] as const) {
            expect((std[name](scalar(), scalar()).node as IrCall).name).toBe(name);
        }
        for (const name of ['sin', 'cos', 'abs', 'floor', 'fract'] as const) {
            expect((std[name](scalar()).node as IrCall).name).toBe(name);
        }
    });
});

describe('std select, sample, discard', () => {
    test('select boxes the condition last', () => {
        const cond = new ShaderValue({ node: local(bool(), 2) });
        const node = std.select(cond, scalar(0), scalar(1)).node as IrCall;
        expect(node.name).toBe('select');
        expect(node.args[2]).toBe(cond.node);
    });

    test('textureSample builds a sample node with a vec4 result', () => {
        const tex = new ShaderValue({ node: binding(texture('f32', '2d', 'sample'), 0, 0) });
        const smp = new ShaderValue({ node: binding(sampler(false), 0, 1) });
        const uv = new ShaderValue({ node: local(vec('f32', 2), 0) });
        const node = std.textureSample(tex, smp, uv).node as IrSample;
        expect(node.kind).toBe('sample');
        expect(node.type).toEqual(v4);
        expect(node.texture).toBe(tex.node);
    });

    test('discard is a statement', () => {
        expect(std.discard()).toEqual({ kind: 'discard' });
    });
});

describe('std constructors', () => {
    test('exposes d constructors', () => {
        expect(std.f32(1).node.kind).toBe('literal');
        expect(std.vec3f(1, 2, 3).node.kind).toBe('construct');
    });
});

import { describe, expect, test } from 'bun:test';
import {
    createExternals,
    createLights,
    createMaterial,
    lights,
    lightContribution,
    material,
    noise,
    scene,
    snoise,
    textures,
    tonemap,
} from './externals';
import { StandardBindings } from '../environment/bindings';
import { EngineMaterialUniforms, Light, MeshUniforms } from '../environment/structs';
import { ShaderValue } from './value';
import { f32, vec } from '../ir/types';
import type { IrAccess, IrBinding, IrCall } from '../ir/nodes';

const v3 = vec('f32', 3);

describe('scene externals', () => {
    test('reads a scalar field as an access over the scene binding', () => {
        const node = scene.cameraX.node as IrAccess;
        expect(node.kind).toBe('access');
        expect(node.index).toBe('cameraX');
        expect(node.type).toEqual(f32());
        const source = node.value as IrBinding;
        expect(source.kind).toBe('binding');
        expect(source.group).toBe(0);
        expect(source.binding).toBe(0);
        expect(source.type).toEqual(MeshUniforms.type);
    });
});

describe('material externals', () => {
    test('reads a field as an access over the material binding', () => {
        const node = material.colorR.node as IrAccess;
        expect(node.index).toBe('colorR');
        const source = node.value as IrBinding;
        expect(source.group).toBe(1);
        expect(source.binding).toBe(0);
        expect(source.type).toEqual(EngineMaterialUniforms.type);
    });

    test('accepts arbitrary user uniforms', () => {
        const custom = createMaterial({ uniforms: { roughness: f32() } });
        const node = custom.roughness.node as IrAccess;
        expect(node.kind).toBe('access');
        expect(node.index).toBe('roughness');
        expect(node.type).toEqual(f32());
    });
});

describe('lights externals', () => {
    test('indexing builds an access over the light array binding', () => {
        const ref = (lights as any)[3];
        const node = ref.prevPosX.node as IrAccess;
        expect(node.index).toBe('prevPosX');
        expect(node.type).toEqual(f32());
        const element = node.value as IrAccess;
        expect(element.kind).toBe('access');
        expect(element.type).toEqual(Light.type);
        const source = element.value as IrBinding;
        expect(source.kind).toBe('binding');
        expect(source.group).toBe(0);
        expect(source.binding).toBe(4);
        expect(source.type).toEqual({ kind: 'array', element: Light.type, count: null });
    });

    test('skinned lights use binding 5', () => {
        const skinned = createLights({ skinned: true });
        const source = skinned.at(0).prevPosX.node.value.value as IrBinding;
        expect(source.binding).toBe(5);
    });

    test('at() matches index access', () => {
        const ref = (lights as any)[2];
        expect(ref.prevPosX.node).toEqual(lights.at(2).prevPosX.node);
    });
});

describe('textures externals', () => {
    test('map and mapSampler use incrementing bindings in group 1', () => {
        const map = textures.map.node as IrBinding;
        expect(map.kind).toBe('binding');
        expect(map.type.kind).toBe('texture');
        expect(map.group).toBe(1);
        expect(map.binding).toBe(1);

        const sampler = textures.mapSampler.node as IrBinding;
        expect(sampler.type.kind).toBe('sampler');
        expect(sampler.group).toBe(1);
        expect(sampler.binding).toBe(2);
    });

    test('further texture pairs increment', () => {
        expect((textures.texture(1).node as IrBinding).binding).toBe(3);
        expect((textures.sampler(1).node as IrBinding).binding).toBe(4);
    });
});

describe('injected functions', () => {
    test('noise and snoise return f32 calls', () => {
        const a = noise(new ShaderValue({ node: (lights as any)[0].currPosX.node })).node as IrCall;
        expect(a.name).toBe('noise');
        expect(a.type).toEqual(f32());

        const b = snoise(new ShaderValue({ node: a }), 8).node as IrCall;
        expect(b.name).toBe('snoise');
        expect(b.type).toEqual(f32());
    });

    test('lightContribution and tonemap return vec3 calls', () => {
        const arg = new ShaderValue({ node: (lights as any)[0].currPosX.node });
        const light = lightContribution(arg, arg, arg, arg, arg, arg).node as IrCall;
        expect(light.name).toBe('lightContribution');
        expect(light.type).toEqual(v3);

        const tone = tonemap(arg).node as IrCall;
        expect(tone.name).toBe('tonemap');
        expect(tone.type).toEqual(v3);
    });
});

describe('createExternals', () => {
    test('honors an override binding map', () => {
        const bindings = new StandardBindings({ sceneBinding: 2, textureStart: 5 });
        const env = createExternals({ bindings });
        expect((env.scene.cameraX.node.value as IrBinding).binding).toBe(2);
        expect((env.textures.map.node as IrBinding).binding).toBe(5);
    });
});

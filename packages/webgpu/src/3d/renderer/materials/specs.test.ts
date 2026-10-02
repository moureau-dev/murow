import { test, expect, describe } from 'bun:test';
import {
    resolveRenderState,
    isTransparent,
    type MaterialSpec,
    type ResolvedRenderState,
} from './specs';

const noopFragment = { fn: () => 0 };

function spec(type: 'standard' | 'unlit' | 'emissive' | 'shader'): MaterialSpec {
    return type === 'shader'
        ? { type: 'shader', shaders: { fragment: noopFragment } }
        : { type };
}

describe('resolveRenderState defaults', () => {
    test('emissive is additive with no depth write and no culling', () => {
        expect(resolveRenderState(spec('emissive'))).toEqual({
            blend: 'additive',
            depthWrite: false,
            depthTest: true,
            cull: 'none',
        });
    });

    for (const type of ['standard', 'unlit', 'shader'] as const) {
        test(`${type} is opaque with depth write and no culling`, () => {
            expect(resolveRenderState(spec(type))).toEqual({
                blend: 'opaque',
                depthWrite: true,
                depthTest: true,
                cull: 'none',
            });
        });
    }
});

describe('resolveRenderState overrides', () => {
    test('explicit fields override every default', () => {
        const base = spec('emissive');
        const overridden: MaterialSpec = {
            ...base,
            type: 'emissive',
            blend: 'alpha',
            depthWrite: true,
            depthTest: false,
            cull: 'back',
        };
        expect(resolveRenderState(overridden)).toEqual({
            blend: 'alpha',
            depthWrite: true,
            depthTest: false,
            cull: 'back',
        });
    });

    test('false depthWrite is preserved rather than falling back to default', () => {
        const s: MaterialSpec = { type: 'standard', depthWrite: false };
        expect(resolveRenderState(s).depthWrite).toBe(false);
    });

    test('false depthTest is preserved', () => {
        const s: MaterialSpec = { type: 'standard', depthTest: false };
        expect(resolveRenderState(s).depthTest).toBe(false);
    });

    test('front cull is preserved', () => {
        const s: MaterialSpec = { type: 'standard', cull: 'front' };
        expect(resolveRenderState(s).cull).toBe('front');
    });

    test('additive blend overrides opaque default on engine types', () => {
        const s: MaterialSpec = { type: 'unlit', blend: 'additive' };
        expect(resolveRenderState(s).blend).toBe('additive');
    });

    test('opaque blend overrides additive default on emissive', () => {
        const s: MaterialSpec = { type: 'emissive', blend: 'opaque' };
        expect(resolveRenderState(s).blend).toBe('opaque');
    });
});

describe('isTransparent', () => {
    const state = (blend: ResolvedRenderState['blend']): ResolvedRenderState => ({
        blend,
        depthWrite: true,
        depthTest: true,
        cull: 'none',
    });

    test('is false only for opaque', () => {
        expect(isTransparent(state('opaque'))).toBe(false);
    });

    test('is true for alpha', () => {
        expect(isTransparent(state('alpha'))).toBe(true);
    });

    test('is true for additive', () => {
        expect(isTransparent(state('additive'))).toBe(true);
    });

    test('matches resolveRenderState for every material type', () => {
        for (const type of ['standard', 'unlit', 'emissive', 'shader'] as const) {
            const resolved = resolveRenderState(spec(type));
            expect(isTransparent(resolved)).toBe(resolved.blend !== 'opaque');
        }
    });
});

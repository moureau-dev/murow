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
        expect(resolveRenderState(spec('emissive'))).toMatchObject({
            blend: 'additive',
            depthWrite: false,
            depthTest: true,
            cull: 'none',
        });
    });

    for (const type of ['standard', 'unlit', 'shader'] as const) {
        test(`${type} is opaque with depth write and no culling`, () => {
            expect(resolveRenderState(spec(type))).toMatchObject({
                blend: 'opaque',
                depthWrite: true,
                depthTest: true,
                cull: 'none',
                blendState: null,
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
        expect(resolveRenderState(overridden)).toMatchObject({
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
        blendState: blend === 'opaque' ? null : {},
        depthWrite: true,
        depthTest: true,
        cull: 'none',
        colorWrite: 15,
        depthBias: 0,
        depthBiasSlopeScale: 0,
        depthBiasClamp: 0,
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
            expect(isTransparent(resolved)).toBe(resolved.blendState !== null);
        }
    });
});

describe('render state extensions', () => {
    test('every non-opaque named mode yields blend components', () => {
        for (const mode of ['alpha', 'additive', 'premultiplied', 'multiply', 'screen'] as const) {
            const r = resolveRenderState({ type: 'standard', blend: mode });
            expect(r.blendState).not.toBeNull();
            expect(isTransparent(r)).toBe(true);
        }
    });

    test('opaque has no blend state', () => {
        expect(resolveRenderState({ type: 'standard' }).blendState).toBeNull();
    });

    test('explicit blendState overrides the named mode and marks transparent', () => {
        const custom = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } as any;
        const r = resolveRenderState({ type: 'standard', blend: 'opaque', blendState: custom });
        expect(r.blendState).toEqual(custom);
        expect(isTransparent(r)).toBe(true);
    });

    test('colorWrite false disables channels; partial masks set bits', () => {
        expect(resolveRenderState({ type: 'standard', colorWrite: false }).colorWrite).toBe(0);
        expect(resolveRenderState({ type: 'standard', colorWrite: { r: true, g: false, b: false, a: false } }).colorWrite).toBe(1);
    });

    test('depthBias resolves with zero defaults', () => {
        const r = resolveRenderState({ type: 'standard', depthBias: { constant: 2, slopeScale: 3, clamp: 0.5 } });
        expect(r.depthBias).toBe(2);
        expect(r.depthBiasSlopeScale).toBe(3);
        expect(r.depthBiasClamp).toBe(0.5);
        expect(resolveRenderState({ type: 'standard' }).depthBias).toBe(0);
    });
});

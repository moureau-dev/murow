import { test, expect, describe } from 'bun:test';
import { blendComponents, RenderState } from './render-state';

describe('blendComponents', () => {
    test('opaque disables blending', () => {
        expect(blendComponents('opaque')).toBeNull();
    });

    test('alpha expands to source-alpha blending', () => {
        expect(blendComponents('alpha')?.color).toEqual({
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
        });
    });

    test('additive uses one as the destination factor', () => {
        expect(blendComponents('additive')?.color?.dstFactor).toBe('one');
    });
});

describe('RenderState', () => {
    test('fills defaults', () => {
        const state = RenderState.resolve();
        expect(state.blend).toBe('opaque');
        expect(state.blendState).toBeNull();
        expect(state.depthWrite).toBe(true);
        expect(state.depthTest).toBe(true);
        expect(state.cull).toBe('none');
        expect(state.colorWrite).toBe(15);
        expect(state.depthBias).toBe(0);
    });

    test('expands a named blend mode', () => {
        const state = new RenderState({ blend: 'premultiplied' });
        expect(state.blendState?.color?.srcFactor).toBe('one');
        expect(state.transparent).toBe(true);
    });

    test('explicit blendState takes precedence', () => {
        const explicit = { color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' } as const };
        const state = new RenderState({ blend: 'alpha', blendState: explicit });
        expect(state.blendState).toEqual(explicit);
    });

    test('blendState null forces blending off', () => {
        const state = new RenderState({ blend: 'alpha', blendState: null });
        expect(state.blendState).toBeNull();
        expect(state.transparent).toBe(false);
    });

    test('resolves color write masks', () => {
        expect(new RenderState({ colorWrite: { r: true, g: false, b: true, a: false } }).colorWrite).toBe(5);
        expect(new RenderState({ colorWrite: false }).colorWrite).toBe(0);
        expect(new RenderState({ colorWrite: true }).writesColor).toBe(true);
    });

    test('carries depth bias values', () => {
        const state = new RenderState({ depthBias: { constant: 1, slopeScale: 2, clamp: 3 } });
        expect([state.depthBias, state.depthBiasSlopeScale, state.depthBiasClamp]).toEqual([1, 2, 3]);
    });

    test('honours overrides', () => {
        const state = new RenderState({ depthWrite: false, depthTest: false, cull: 'back' });
        expect(state.depthWrite).toBe(false);
        expect(state.depthTest).toBe(false);
        expect(state.cull).toBe('back');
    });
});

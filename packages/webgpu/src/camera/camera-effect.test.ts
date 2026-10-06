import { test, expect, describe } from 'bun:test';
import { CameraEffect, CameraEffectList } from './camera-effect';

describe('CameraEffect', () => {
    test('flattens the spec onto the instance', () => {
        const e = new CameraEffect({ type: 'vignette', strength: 0.4 });
        expect(e.type).toBe('vignette');
        expect(e.strength).toBe(0.4);
        expect(e.enabled).toBe(true);
    });

    test('custom effects get a params object from defaultUniforms', () => {
        const e = new CameraEffect({
            type: 'shader',
            fragment: () => 0,
            defaultUniforms: { threshold: 0.7 },
        });
        expect(e.params).toEqual({ threshold: 0.7 });
    });
});

describe('CameraEffectList', () => {
    test('add() accepts a spec or an effect and returns the effect', () => {
        const list = new CameraEffectList();
        const e = list.add({ type: 'grade', saturation: 1.2 });
        expect(e).toBeInstanceOf(CameraEffect);
        expect(list.count).toBe(1);
        expect(list.at(0)).toBe(e);
    });

    test('set() replaces the chain in order', () => {
        const list = new CameraEffectList();
        list.set([{ type: 'vignette' }, { type: 'grayscale' }, { type: 'chromatic' }]);
        expect(list.count).toBe(3);
        expect(list.at(0)!.type).toBe('vignette');
        expect(list.at(2)!.type).toBe('chromatic');
    });

    test('remove() and clear()', () => {
        const list = new CameraEffectList();
        const a = list.add({ type: 'grade' });
        list.add({ type: 'vignette' });
        list.remove(a);
        expect(list.count).toBe(1);
        expect(list.at(0)!.type).toBe('vignette');
        list.clear();
        expect(list.count).toBe(0);
    });

    test('enableCount() counts only enabled effects', () => {
        const list = new CameraEffectList();
        list.add({ type: 'grade' });
        const off = list.add({ type: 'vignette' });
        off.enabled = false;
        expect(list.enableCount()).toBe(1);
    });

    test('recycles ids when an effect is removed', () => {
        const list = new CameraEffectList(2);
        const a = list.add({ type: 'grade' });
        const b = list.add({ type: 'vignette' });
        expect([a.id, b.id].sort()).toEqual([0, 1]);
        const freed = a.id;
        list.remove(a);
        const c = list.add({ type: 'grayscale' });
        expect(c.id).toBe(freed);
    });

    test('throws past capacity', () => {
        const list = new CameraEffectList(1);
        list.add({ type: 'grade' });
        expect(() => list.add({ type: 'vignette' })).toThrow();
    });
});

import { describe, expect, test } from 'bun:test';
import { StandardBindings, defaultBindings } from './bindings';

describe('StandardBindings', () => {
    test('defaults match the engine layout', () => {
        expect(defaultBindings.sceneGroup).toBe(0);
        expect(defaultBindings.sceneBinding).toBe(0);
        expect(defaultBindings.lightsGroup).toBe(0);
        expect(defaultBindings.lightsBinding).toBe(4);
        expect(defaultBindings.skinnedLightsBinding).toBe(5);
        expect(defaultBindings.materialGroup).toBe(1);
        expect(defaultBindings.materialBinding).toBe(0);
        expect(defaultBindings.textureStart).toBe(1);
    });

    test('lights picks the skinned binding', () => {
        expect(defaultBindings.lights(false)).toBe(4);
        expect(defaultBindings.lights(true)).toBe(5);
    });

    test('texture pairs increment by two', () => {
        expect(defaultBindings.texture(0)).toBe(1);
        expect(defaultBindings.texture(1)).toBe(3);
        expect(defaultBindings.texture(3)).toBe(7);
    });

    test('options override any slot', () => {
        const custom = new StandardBindings({
            sceneBinding: 2,
            lightsBinding: 6,
            skinnedLightsBinding: 7,
            materialBinding: 1,
            textureStart: 4,
        });
        expect(custom.sceneBinding).toBe(2);
        expect(custom.lights(false)).toBe(6);
        expect(custom.lights(true)).toBe(7);
        expect(custom.materialBinding).toBe(1);
        expect(custom.texture(0)).toBe(4);
    });
});

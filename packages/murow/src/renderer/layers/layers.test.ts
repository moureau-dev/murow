import { describe, expect, test } from 'bun:test';
import { ALL_LAYERS, LayerRegistry, visibleTo } from './layers';

describe('LayerRegistry', () => {
    test('defines the default layer at bit 0', () => {
        const layers = new LayerRegistry();
        expect(layers.defaultName).toBe('default');
        expect(layers.defaultBit).toBe(1);
        expect(layers.nameOf(1)).toBe('default');
        expect(layers.count).toBe(1);
        expect(layers.definedMask).toBe(1);
        expect(layers.all).toBe(ALL_LAYERS);
    });

    test('define is sequential and idempotent', () => {
        const layers = new LayerRegistry();
        expect(layers.define('world')).toBe(2);
        expect(layers.define('ui')).toBe(4);
        expect(layers.define('world')).toBe(2);
        expect(layers.count).toBe(3);
        expect(layers.definedMask).toBe(7);
    });

    test('mask ORs names and rejects unknown names', () => {
        const layers = new LayerRegistry();
        const world = layers.define('world');
        const ui = layers.define('ui');
        expect(layers.mask('world', 'ui')).toBe(world | ui);
        expect(() => layers.mask('missing')).toThrow("unknown layer 'missing'");
    });

    test('resolveLayer handles names, bits and the default', () => {
        const layers = new LayerRegistry();
        const world = layers.define('world');
        const ui = layers.define('ui');
        expect(layers.resolveLayer()).toBe(layers.defaultBit);
        expect(layers.resolveLayer('world')).toBe(world);
        expect(layers.resolveLayer(ui)).toBe(ui);
        expect(() => layers.resolveLayer(0)).toThrow('not a single layer bit');
        expect(() => layers.resolveLayer(world | ui)).toThrow('not a single layer bit');
        expect(() => layers.resolveLayer('missing')).toThrow("unknown layer 'missing'");
    });

    test('resolveMask handles numbers, names and lists', () => {
        const layers = new LayerRegistry();
        const world = layers.define('world');
        const ui = layers.define('ui');
        expect(layers.resolveMask()).toBe(ALL_LAYERS);
        expect(layers.resolveMask('world')).toBe(world);
        expect(layers.resolveMask(['world', 'ui'])).toBe(world | ui);
        expect(layers.resolveMask(world | ui)).toBe(world | ui);
    });

    test('visibleTo tests the bit', () => {
        const layers = new LayerRegistry();
        const world = layers.define('world');
        const ui = layers.define('ui');
        expect(visibleTo(world, world | ui)).toBe(true);
        expect(visibleTo(ui, world)).toBe(false);
    });

    test('emits add and clear events and exposes count', () => {
        const layers = new LayerRegistry();
        const log: string[] = [];
        layers.events.on('add', ({ name }) => log.push(name));
        layers.events.on('clear', () => log.push('clear'));
        layers.define('world');
        expect(layers.count).toBe(2);
        layers.clear();
        expect(log).toEqual(['world', 'default', 'clear']);
    });

    test('throws when capacity is reached', () => {
        const layers = new LayerRegistry({ capacity: 2 });
        layers.define('world');
        expect(() => layers.define('ui')).toThrow('LayerRegistry capacity (2) reached');
    });

    test('supports a custom default layer name', () => {
        const layers = new LayerRegistry({ defaultLayer: 'world' });
        expect(layers.defaultName).toBe('world');
        expect(layers.defaultBit).toBe(1);
        expect(layers.resolveLayer()).toBe(1);
        expect(layers.has('default')).toBe(false);
    });

    test('clear resets to only the default layer', () => {
        const layers = new LayerRegistry();
        layers.define('world');
        layers.clear();
        expect(layers.count).toBe(1);
        expect(layers.definedMask).toBe(1);
        expect(layers.has('world')).toBe(false);
    });

    test('rejects invalid configuration', () => {
        expect(() => new LayerRegistry({ capacity: 0 })).toThrow('capacity must be an integer');
        expect(() => new LayerRegistry({ capacity: 33 })).toThrow('capacity must be an integer');
        expect(() => new LayerRegistry({ defaultLayer: '' })).toThrow('defaultLayer must be a non-empty name');
        expect(() => new LayerRegistry().define('')).toThrow('layer name must not be empty');
    });
});

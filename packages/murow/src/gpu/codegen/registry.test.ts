import { test, expect, describe } from 'bun:test';
import { IntrinsicRegistry, NameIdRegistry, NodeRegistry } from './registry';

describe('NameIdRegistry', () => {
    test('registers and reads entries by name', () => {
        const registry = new NameIdRegistry<number>();
        registry.register('a', 1);
        registry.register('b', 2);
        expect(registry.size).toBe(2);
        expect(registry.get('a')).toBe(1);
        expect(registry.get('b')).toBe(2);
        expect(registry.getEntry('b')?.fn).toBe(2);
        expect(registry.has('a')).toBe(true);
        expect(registry.has('z')).toBe(false);
        expect(registry.get('z')).toBeUndefined();
        expect(registry.names()).toEqual(['a', 'b']);
    });

    test('accepts entries through options', () => {
        const registry = new NameIdRegistry<number>({
            entries: [
                { name: 'x', fn: 10 },
                { name: 'y', fn: 20 },
            ],
        });
        expect(registry.size).toBe(2);
        expect(registry.get('y')).toBe(20);
    });

    test('rejects duplicate registration', () => {
        const registry = new NameIdRegistry<number>();
        registry.register('a', 1);
        expect(() => registry.register('a', 2)).toThrow();
    });

    test('override replaces in place and keeps size', () => {
        const registry = new NameIdRegistry<number>();
        registry.register('a', 1);
        registry.override('a', 9);
        expect(registry.get('a')).toBe(9);
        expect(registry.size).toBe(1);
    });

    test('override registers when absent', () => {
        const registry = new NameIdRegistry<number>();
        registry.override('new', 5);
        expect(registry.get('new')).toBe(5);
        expect(registry.size).toBe(1);
    });

    test('names do not collide with object prototype keys', () => {
        const registry = new NameIdRegistry<number>();
        registry.register('toString', 7);
        expect(registry.has('toString')).toBe(true);
        expect(registry.get('toString')).toBe(7);
    });
});

describe('NodeRegistry', () => {
    test('stores node emitters', () => {
        const registry = new NodeRegistry();
        registry.register('raw', () => 'raw');
        expect(registry.size).toBe(1);
        expect(registry.get('raw')?.()).toBe('raw');
    });
});

describe('IntrinsicRegistry', () => {
    test('stores intrinsic implementations', () => {
        const registry = new IntrinsicRegistry();
        registry.register('double', () => 'x * 2');
        expect(registry.has('double')).toBe(true);
        expect(registry.get('double')?.([], {} as never)).toBe('x * 2');
    });
});

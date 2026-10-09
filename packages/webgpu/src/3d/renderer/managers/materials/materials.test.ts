import { describe, expect, test } from 'bun:test';
import { Logger } from 'murow/core';
import type { MaterialLibrary } from './material-library';
import { MaterialManager } from './materials';

function makeManager() {
    const names = new Set<string>();
    const library = {
        hasName: (name: string) => names.has(name),
        createMaterial: (spec: { name?: string }) => {
            if (spec.name !== undefined) names.add(spec.name);
            return { name: spec.name ?? '', slot: 0, uniforms: {}, destroy() { /* no-op */ } };
        },
    } as unknown as MaterialLibrary;
    const manager = new MaterialManager({ capacity: 4, logger: Logger.none, library });
    return { manager, names };
}

describe('MaterialManager names', () => {
    test('registers a unique name on the handle', () => {
        const { manager } = makeManager();
        const handle = manager.create({ name: 'hero', type: 'unlit' });
        expect(handle).not.toBeNull();
        expect(handle!.name).toBe('hero');
    });

    test('auto-assigns a mat_ name when omitted', () => {
        const { manager, names } = makeManager();
        const handle = manager.create({ type: 'unlit' });
        expect(handle).not.toBeNull();
        expect(handle!.name.startsWith('mat_')).toBe(true);
        expect(names.has(handle!.name)).toBe(true);
    });

    test('throws when a name is already registered', () => {
        const { manager } = makeManager();
        manager.create({ name: 'hero', type: 'unlit' });
        expect(() => manager.create({ name: 'hero', type: 'unlit' }))
            .toThrow('Material "hero" is already registered');
    });

    test('a failed duplicate does not consume a slot', () => {
        const { manager } = makeManager();
        manager.create({ name: 'hero', type: 'unlit' });
        const before = manager.count;
        expect(() => manager.create({ name: 'hero', type: 'unlit' })).toThrow();
        expect(manager.count).toBe(before);
    });
});

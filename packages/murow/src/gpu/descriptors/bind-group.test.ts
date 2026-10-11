import { test, expect, describe } from 'bun:test';
import { ALL_STAGES, BindGroupLayout, binding, visibility } from './bind-group';

describe('BindingEntry', () => {
    test('normalizes partial visibility', () => {
        const entry = binding({ name: 'camera', binding: 0, type: 'uniform', visibility: { vertex: true } });
        expect(entry.visibility).toEqual({ vertex: true, fragment: false, compute: false });
    });

    test('visibility helper fills all stages', () => {
        expect(visibility()).toEqual({ vertex: false, fragment: false, compute: false });
        expect(visibility({ compute: true })).toEqual({ vertex: false, fragment: false, compute: true });
    });
});

describe('BindGroupLayout', () => {
    const entries = [
        binding({ name: 'camera', binding: 0, type: 'uniform', visibility: ALL_STAGES }),
        binding({ name: 'map', binding: 1, type: 'texture', visibility: { fragment: true } }),
    ];

    test('looks up entries by name and binding number', () => {
        const layout = new BindGroupLayout({ name: 'frame', entries });
        expect(layout.name).toBe('frame');
        expect(layout.size).toBe(2);
        expect(layout.get('map')?.type).toBe('texture');
        expect(layout.getByBinding(0)?.name).toBe('camera');
        expect(layout.has('nope')).toBe(false);
        expect(layout.bindingOf('map')).toBe(1);
    });

    test('withName returns a renamed copy', () => {
        const layout = new BindGroupLayout({ entries });
        const named = layout.withName('frame');
        expect(named.name).toBe('frame');
        expect(named.get('camera')).toBeDefined();
    });

    test('rejects duplicate binding numbers', () => {
        expect(
            () =>
                new BindGroupLayout({
                    entries: [
                        binding({ name: 'a', binding: 0, type: 'uniform' }),
                        binding({ name: 'b', binding: 0, type: 'storage' }),
                    ],
                }),
        ).toThrow();
    });

    test('rejects duplicate names', () => {
        expect(
            () =>
                new BindGroupLayout({
                    entries: [
                        binding({ name: 'a', binding: 0, type: 'uniform' }),
                        binding({ name: 'a', binding: 1, type: 'storage' }),
                    ],
                }),
        ).toThrow();
    });

    test('rejects invalid binding numbers', () => {
        expect(() => new BindGroupLayout({ entries: [binding({ name: 'a', binding: -1, type: 'uniform' })] })).toThrow();
    });
});

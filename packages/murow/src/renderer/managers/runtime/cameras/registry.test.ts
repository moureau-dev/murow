import { describe, expect, test } from 'bun:test';
import { CameraRegistry, type RegisteredCamera } from './registry';

interface TestCamera extends RegisteredCamera {
    previous: number;
    interpolated: number;
}

function camera(priority = 0, enabled = true): TestCamera {
    return {
        id: -1,
        enabled,
        priority,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        clearDepth: true,
        mask: 0xffffffff,
        previous: 0,
        interpolated: 0,
        storePrevious() { this.previous += 1; },
        interpolate(alpha: number) { this.interpolated = alpha; },
    };
}

describe('CameraRegistry', () => {
    test('adds a camera and assigns unique ids', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        const a = registry.add(camera());
        const b = registry.add(camera());
        expect(a.id).not.toBe(b.id);
        expect(registry.count).toBe(2);
        expect(registry.get(a.id)).toBe(a);
        expect(registry.get(b.id)).toBe(b);
    });

    test('first camera is primary and setPrimary moves it', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        const a = registry.add(camera());
        const b = registry.add(camera());
        expect(registry.primary).toBe(a);
        expect(registry.setPrimary(b)).toBe(true);
        expect(registry.primary).toBe(b);
        expect(registry.setPrimary(99)).toBe(false);
    });

    test('create uses the factory and throws at capacity', () => {
        const registry = new CameraRegistry<TestCamera, { priority: number }>(
            2,
            ({ priority }) => camera(priority),
        );
        const a = registry.create({ priority: 2 });
        const b = registry.create({ priority: 1 });
        expect(a.priority).toBe(2);
        expect(b.priority).toBe(1);
        expect(() => registry.create({ priority: 0 })).toThrow('capacity (2) reached');
    });

    test('add throws at capacity', () => {
        const registry = new CameraRegistry<TestCamera>(1);
        registry.add(camera());
        expect(() => registry.add(camera())).toThrow('capacity (1) reached');
    });

    test('create without a factory throws', () => {
        const registry = new CameraRegistry<TestCamera>(1);
        expect(() => registry.create({} as never)).toThrow('create() requires a factory');
    });

    test('remove keeps at least one camera and moves primary', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        const a = registry.add(camera());
        const b = registry.add(camera());
        expect(registry.remove(a)).toBe(true);
        expect(registry.primary).toBe(b);
        expect(registry.get(a.id)).toBeUndefined();
        expect(registry.remove(b)).toBe(false);
        expect(registry.count).toBe(1);
    });

    test('reuses freed ids', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        const a = registry.add(camera());
        registry.add(camera());
        expect(registry.remove(a)).toBe(true);
        const reused = registry.add(camera());
        expect(reused.id).toBe(a.id);
    });

    test('ordered reuses one array', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        registry.add(camera(1));
        const first = registry.ordered();
        const second = registry.ordered();
        expect(second).toBe(first);
    });

    test('ordered filters disabled cameras and sorts by priority', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        const a = registry.add(camera(2));
        const b = registry.add(camera(0, false));
        const c = registry.add(camera(1));
        expect(registry.ordered()).toEqual([c, a]);
        expect(registry.ordered()).not.toContain(b);
    });

    test('storePrevious and interpolate run for every camera', () => {
        const registry = new CameraRegistry<TestCamera>(4);
        const a = registry.add(camera());
        const b = registry.add(camera());
        registry.storePrevious();
        registry.interpolate(0.5);
        expect(a.previous).toBe(1);
        expect(b.previous).toBe(1);
        expect(a.interpolated).toBe(0.5);
        expect(b.interpolated).toBe(0.5);
    });

    test('rejects invalid capacity', () => {
        expect(() => new CameraRegistry<TestCamera>(0)).toThrow('positive integer');
    });
});

import { test, expect, describe } from 'bun:test';
import { ParticleEmitter } from './emitter';
import type { WebGPU2DRenderer } from '../2d/renderer';
import type { SpritesheetHandle } from 'murow/renderer';

class MockRenderer {
    readonly live = new Set<{ x: number; y: number; opacity: number }>();
    added = 0;
    removed = 0;
    readonly sprites = {
        add: (_opts: unknown) => {
            const s = {
                x: 0, y: 0, opacity: 1,
                destroy: () => {
                    this.live.delete(s);
                    this.removed++;
                },
            };
            this.live.add(s);
            this.added++;
            return s;
        },
    };
}

const sheet = {} as SpritesheetHandle;

function make() {
    const renderer = new MockRenderer();
    const emitter = new ParticleEmitter(renderer as unknown as WebGPU2DRenderer, {
        max: 4,
        lifetime: { min: 1, max: 1 },
        speed: { min: 0, max: 0 },
        size: { min: 1, max: 1 },
        direction: { min: 0, max: 0 },
        color: [1, 1, 1, 1],
        sheet,
        seed: 1,
    });
    return { renderer, emitter };
}

describe('ParticleEmitter', () => {
    test('emit creates sprites and counts them active', () => {
        const { renderer, emitter } = make();
        emitter.emit(0, 0, 3);
        expect(renderer.added).toBe(3);
        expect(emitter.getActiveCount()).toBe(3);
    });

    test('particles expire and are removed', () => {
        const { renderer, emitter } = make();
        emitter.emit(0, 0, 3);
        emitter.update(2);
        expect(emitter.getActiveCount()).toBe(0);
        expect(renderer.removed).toBe(3);
    });

    test('emitting past max reuses ring slots', () => {
        const { renderer, emitter } = make();
        emitter.emit(0, 0, 4);
        expect(emitter.getActiveCount()).toBe(4);
        emitter.emit(0, 0, 1);
        expect(emitter.getActiveCount()).toBe(4);
        expect(renderer.removed).toBe(1);
        expect(renderer.added).toBe(5);
    });

    test('clear removes all active particles', () => {
        const { renderer, emitter } = make();
        emitter.emit(0, 0, 3);
        emitter.clear();
        expect(emitter.getActiveCount()).toBe(0);
        expect(renderer.removed).toBe(3);
    });
});

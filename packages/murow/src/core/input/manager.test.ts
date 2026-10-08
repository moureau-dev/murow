import { afterEach, describe, expect, test } from 'bun:test';
import { InputManager } from './manager';
import type { InputEventSource, InputHandlers } from './types';

class FakeSource implements InputEventSource {
    handlers!: InputHandlers;
    attach(handlers: InputHandlers): void { this.handlers = handlers; }
    detach(): void { /* no-op */ }
}

const TARGET = {
    getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        width: 800,
        height: 600,
        right: 900,
        bottom: 650,
        x: 100,
        y: 50,
        toJSON: () => ({}),
    }),
};

function move(source: FakeSource, overrides: Partial<MouseEvent>): void {
    source.handlers.mousemove({
        target: TARGET,
        clientX: 0,
        clientY: 0,
        movementX: 0,
        movementY: 0,
        ...overrides,
    } as unknown as MouseEvent);
}

function setLock(element: unknown): void {
    (globalThis as unknown as { document: unknown }).document = { pointerLockElement: element };
}

afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
});

describe('InputManager pointer lock', () => {
    test('publishes the pointer position while unlocked', () => {
        setLock(null);
        const source = new FakeSource();
        const input = new InputManager();
        input.listen(source);

        move(source, { clientX: 300, clientY: 150 });

        const snap = input.snapshot();
        expect(snap.mouse.position.x).toBe(200);
        expect(snap.mouse.position.y).toBe(100);
    });

    test('publishes the viewport center while locked', () => {
        setLock(TARGET);
        const source = new FakeSource();
        const input = new InputManager();
        input.listen(source);

        move(source, { clientX: 300, clientY: 150, movementX: 7, movementY: -4 });

        const snap = input.snapshot();
        expect(snap.mouse.position.x).toBe(400);
        expect(snap.mouse.position.y).toBe(300);
        expect(snap.mouse.delta.position.x).toBe(7);
        expect(snap.mouse.delta.position.y).toBe(-4);
    });
});

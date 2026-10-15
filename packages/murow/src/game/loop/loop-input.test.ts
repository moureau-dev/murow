import { describe, expect, test } from 'bun:test';
import { GameLoop } from './loop';
import { InputManager } from '../../core/input';
import type { InputEventSource, InputHandlers } from '../../core/input/types';

class FakeSource implements InputEventSource {
    handlers!: InputHandlers;
    attach(handlers: InputHandlers): void { this.handlers = handlers; }
    detach(): void { /* no-op */ }
}

function makeManager(): { manager: InputManager; source: FakeSource } {
    const manager = new InputManager();
    const source = new FakeSource();
    manager.listen(source);
    return { manager, source };
}

const keydown = (source: FakeSource, code: string) =>
    source.handlers.keydown({ code } as KeyboardEvent);

describe('GameLoop input managers', () => {
    test('uses a provided inputManager instead of the browser one', () => {
        const { manager, source } = makeManager();
        const loop = new GameLoop({ tickRate: 60, type: 'manual-client', inputManager: manager });
        keydown(source, 'KeyW');

        let input: any = null;
        loop.events.on('tick', (data) => { input = data.input; });
        loop.step(1 / 60 + 0.001);

        expect(loop.inputManager).toBe(manager);
        expect(input.keys['KeyW']?.down).toBe(true);
        expect(input.keys['KeyW']?.hit).toBe(true);
    });

    test('merges several inputManagers into one snapshot', () => {
        const a = makeManager();
        const b = makeManager();
        const loop = new GameLoop({
            tickRate: 60,
            type: 'manual-client',
            inputManagers: [a.manager, b.manager],
        });
        keydown(a.source, 'KeyW');
        keydown(b.source, 'Space');

        let input: any = null;
        loop.events.on('tick', (data) => { input = data.input; });
        loop.step(1 / 60 + 0.001);

        expect(input.keys['KeyW']?.down).toBe(true);
        expect(input.keys['Space']?.down).toBe(true);
        expect(input.keys['Space']?.hit).toBe(true);
    });

    test('render peek merges live state with no hit/release', () => {
        const a = makeManager();
        const b = makeManager();
        const loop = new GameLoop({
            tickRate: 60,
            type: 'manual-client',
            inputManagers: [a.manager, b.manager],
        });
        keydown(a.source, 'KeyW');
        keydown(b.source, 'KeyE');

        let peek: any = null;
        loop.events.on('render', (data) => { peek = data.input; });
        loop.step(1 / 60 + 0.001);

        expect(peek.keys['KeyW']?.down).toBe(true);
        expect(peek.keys['KeyE']?.down).toBe(true);
        expect(peek.keys['KeyW']?.hit).toBe(false);
    });

    test('setInputManagers swaps the active set at runtime', () => {
        const a = makeManager();
        const b = makeManager();
        const loop = new GameLoop({ tickRate: 60, type: 'manual-client', inputManager: a.manager });

        loop.setInputManagers([b.manager]);
        keydown(a.source, 'KeyW');
        keydown(b.source, 'KeyD');

        let input: any = null;
        loop.events.on('tick', (data) => { input = data.input; });
        loop.step(1 / 60 + 0.001);

        expect(input.keys['KeyD']?.down).toBe(true);
        expect(input.keys['KeyW']).toBeUndefined();
    });

    test('setInputManager(null) restores the loop-owned manager', () => {
        const a = makeManager();
        const loop = new GameLoop({ tickRate: 60, type: 'manual-client', inputManager: a.manager });
        expect(loop.inputManager).toBe(a.manager);

        loop.setInputManager(null);

        expect(loop.inputManager).not.toBe(a.manager);
        expect(loop.inputManagers.length).toBe(1);
    });
});

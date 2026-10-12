import { test, expect, describe } from 'bun:test';
import { ResizeController, type ResizeObserverFactory } from './resize-controller';

Object.assign(globalThis, { devicePixelRatio: 1 });

function entry(inlineSize: number, blockSize: number) {
    return {
        contentBoxSize: [{ inlineSize, blockSize }],
        devicePixelContentBoxSize: [{ inlineSize, blockSize }],
    } as unknown as ResizeObserverEntry;
}

/** Fake ResizeObserver that captures the callback so a test can drive it. */
function fakeObserverFactory() {
    const callbacks: ResizeObserverCallback[] = [];
    const factory: ResizeObserverFactory = (cb) => {
        callbacks.push(cb);
        return { observe() {}, disconnect() {} } as unknown as ResizeObserver;
    };
    return { factory, callbacks };
}

describe('ResizeController', () => {
    test('applies and notifies on size change', () => {
        const { factory, callbacks } = fakeObserverFactory();
        const applied: number[][] = [];
        const notified: number[][] = [];
        const rc = new ResizeController({} as HTMLCanvasElement, (w, h, cw, ch) => applied.push([w, h, cw, ch]), factory);
        rc.start(100, 100);
        rc.onResize((w, h) => notified.push([w, h]));

        // last captured callback is the real observer
        callbacks[callbacks.length - 1]([entry(200, 150)], {} as ResizeObserver);

        expect(applied).toEqual([[200, 150, 200, 150]]);
        expect(notified).toEqual([[200, 150]]);
    });

    test('ignores no-op duplicate sizes', () => {
        const { factory, callbacks } = fakeObserverFactory();
        let count = 0;
        const rc = new ResizeController({} as HTMLCanvasElement, () => { count++; }, factory);
        rc.start(100, 100);

        const cb = callbacks[callbacks.length - 1];
        cb([entry(100, 100)], {} as ResizeObserver);
        expect(count).toBe(0);
        cb([entry(120, 100)], {} as ResizeObserver);
        cb([entry(120, 100)], {} as ResizeObserver);
        expect(count).toBe(1);
    });

    test('disconnect drops listeners', () => {
        const { factory, callbacks } = fakeObserverFactory();
        const rc = new ResizeController({} as HTMLCanvasElement, () => {}, factory);
        rc.start(100, 100);
        rc.onResize(() => { throw new Error('should not fire'); });
        rc.disconnect();
        // observer callback may still be invoked, but listeners were cleared
        expect(() => callbacks[callbacks.length - 1]([entry(300, 300)], {} as ResizeObserver)).not.toThrow();
    });
});

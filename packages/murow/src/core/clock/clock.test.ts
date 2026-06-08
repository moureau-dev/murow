import { describe, test, expect } from 'bun:test';
import { SlewClock } from './clock';

describe('SlewClock', () => {
    test('seeds to the target on first advance', () => {
        const c = new SlewClock();
        expect(c.initialized).toBe(false);
        expect(c.advance(5, 100)).toBe(5);
        expect(c.initialized).toBe(true);
    });

    test('drift inside the dead-zone advances one nominal step', () => {
        const c = new SlewClock();
        c.advance(5, 100);
        // target 5.1 is 0.1 from value 5, under the 0.25 dead-zone -> +1.
        expect(c.advance(5.1, 100)).toBe(6);
    });

    test('forward drift beyond snap jumps to the target', () => {
        const c = new SlewClock();
        c.advance(10, 2);
        // drift 5 > snap 2 -> snap.
        expect(c.advance(15, 2)).toBe(15);
    });

    test('moderate drift warps within the band', () => {
        const c = new SlewClock();
        c.advance(0, 100);
        // drift 2 -> 1 + 2*0.1 = 1.2, inside [0.6, 1.4].
        expect(c.advance(2, 100)).toBeCloseTo(1.2);
    });

    test('warp step is clamped to the band', () => {
        const c = new SlewClock();
        c.advance(0, 100);
        // drift 20 (but under snap 100) -> 1 + 2.0 clamps to 1.4.
        expect(c.advance(20, 100)).toBeCloseTo(1.4);
    });

    test('reset re-seeds on the next advance', () => {
        const c = new SlewClock();
        c.advance(5, 100);
        c.reset();
        expect(c.initialized).toBe(false);
        expect(c.advance(99, 100)).toBe(99);
    });
});

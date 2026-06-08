import { describe, test, expect } from 'bun:test';
import { Timeline } from './timeline';

describe('Timeline', () => {
    test('inserts in tick order and reports newest/oldest', () => {
        const tl = new Timeline<string>(8, 300);
        tl.record(1, 1000, 'a');
        tl.record(3, 1200, 'c');
        tl.record(2, 1100, 'b');
        expect(tl.length).toBe(3);
        expect(tl.oldest()!.tick).toBe(1);
        expect(tl.newest()!.tick).toBe(3);
        expect(tl.at(1).sample).toBe('b');
    });

    test('dedups by tick', () => {
        const tl = new Timeline<string>(8, 300);
        tl.record(1, 1000, 'a');
        tl.record(2, 1100, 'b');
        tl.record(2, 1150, 'b2');
        expect(tl.length).toBe(2);
        expect(tl.at(1).sample).toBe('b');
    });

    test('straddle finds the bracketing pair', () => {
        const tl = new Timeline<string>(8, 300);
        tl.record(1, 1000, 'a');
        tl.record(2, 1100, 'b');
        tl.record(3, 1200, 'c');
        expect(tl.straddle(2.5)).toEqual([1, 2]);
        expect(tl.straddle(1)).toEqual([0, 1]);
        expect(tl.straddle(9)).toBeNull();
    });

    test('prunes to capacity, dropping the oldest', () => {
        const tl = new Timeline<string>(2, 300);
        tl.record(1, 1000, 'a');
        tl.record(2, 1100, 'b');
        tl.record(3, 1200, 'c');
        expect(tl.length).toBe(2);
        expect(tl.oldest()!.tick).toBe(2);
    });

    test('a wall-clock gap beyond the stale window resets and reports it', () => {
        const tl = new Timeline<string>(8, 300);
        expect(tl.record(1, 1000, 'a')).toBe(false);
        expect(tl.record(2, 2000, 'b')).toBe(true);
        expect(tl.length).toBe(1);
        expect(tl.newest()!.tick).toBe(2);
    });
});

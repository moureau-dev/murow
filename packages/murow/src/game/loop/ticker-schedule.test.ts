import { describe, test, expect } from 'bun:test';
import { TickerSchedule } from './ticker-schedule';

// Drive the scheduler one tick at a time so the realign logic is exercised
// the same way the loop drives it.
function advance(s: TickerSchedule, from: number, ticks: number) {
    for (let t = from; t < from + ticks; t++) s.run(t);
}

describe('TickerSchedule', () => {
    test('fires on the interval and realigns from the current tick', () => {
        const s = new TickerSchedule(8);
        let fired = 0;
        s.every(3, () => { fired++; }, 0); // next = 3

        advance(s, 0, 10); // ticks 0..9, fires at 3, 6, 9
        expect(fired).toBe(3);
    });

    test('a long gap fires once, not a burst', () => {
        const s = new TickerSchedule(8);
        let fired = 0;
        s.every(3, () => { fired++; }, 0);

        s.run(100); // skipped well past several intervals
        expect(fired).toBe(1);
    });

    test('clear cancels a single schedule', () => {
        const s = new TickerSchedule(8);
        let fired = 0;
        const id = s.every(2, () => { fired++; }, 0);

        s.run(2);
        expect(fired).toBe(1);
        expect(s.clear(id)).toBe(true);
        advance(s, 3, 10);
        expect(fired).toBe(1);
    });

    test('clearAll cancels everything and frees capacity', () => {
        const s = new TickerSchedule(8);
        let a = 0, b = 0;
        s.every(2, () => { a++; }, 0);
        s.every(2, () => { b++; }, 0);

        s.clearAll();
        expect(s.size).toBe(0);
        advance(s, 1, 10);
        expect(a).toBe(0);
        expect(b).toBe(0);
    });

    test('stale id from a recycled slot does not cancel the new schedule', () => {
        const s = new TickerSchedule(1); // force slot reuse
        const oldId = s.every(2, () => {}, 0);
        s.clear(oldId);

        let fired = 0;
        const newId = s.every(2, () => { fired++; }, 0); // reuses the only slot

        expect(oldId).not.toBe(newId);
        expect(s.clear(oldId)).toBe(false); // stale id is rejected
        s.run(2);
        expect(fired).toBe(1); // new schedule survived
    });

    test('clearing twice with the same id is a safe no-op', () => {
        const s = new TickerSchedule(8);
        const id = s.every(2, () => {}, 0);
        expect(s.clear(id)).toBe(true);
        expect(s.clear(id)).toBe(false);
    });

    test('returns -1 when at capacity', () => {
        const s = new TickerSchedule(2);
        expect(s.every(1, () => {}, 0)).not.toBe(-1);
        expect(s.every(1, () => {}, 0)).not.toBe(-1);
        expect(s.every(1, () => {}, 0)).toBe(-1);
    });

    test('rebase re-anchors live schedules to a new origin', () => {
        const s = new TickerSchedule(8);
        let fired = 0;
        s.every(3, () => { fired++; }, 0);

        advance(s, 0, 4); // fires once at 3
        expect(fired).toBe(1);

        s.rebase(0); // tick count reset to 0
        advance(s, 0, 4); // fires once more at 3
        expect(fired).toBe(2);
    });

    test('a callback may cancel itself mid-run without skipping siblings', () => {
        const s = new TickerSchedule(8);
        let self = 0, other = 0;
        let id = 0;
        id = s.every(2, () => { self++; s.clear(id); }, 0);
        s.every(2, () => { other++; }, 0);

        advance(s, 0, 7);
        expect(self).toBe(1);             // cancelled after first fire
        expect(other).toBeGreaterThan(1); // sibling kept firing
    });

    test('a callback may register a schedule mid-run; capacity is reused over time', () => {
        const s = new TickerSchedule(4);
        let added = 0;
        let registered = false;
        s.every(2, () => {
            if (!registered) {
                registered = true;
                s.every(2, () => { added++; }, 2);
            }
        }, 0);

        advance(s, 0, 8);
        expect(registered).toBe(true);
        expect(added).toBeGreaterThan(0);
    });
});

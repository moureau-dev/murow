import { test, expect, describe } from 'bun:test';
import { SimpleRNG } from './simple-rng';

describe('SimpleRNG', () => {
    describe('rand', () => {
        test('returns values in [0, 1)', () => {
            const rng = new SimpleRNG(42);
            for (let i = 0; i < 1000; i++) {
                const v = rng.rand();
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThan(1);
            }
        });

        test('same seed produces same sequence', () => {
            const a = new SimpleRNG(123);
            const b = new SimpleRNG(123);
            for (let i = 0; i < 100; i++) {
                expect(a.rand()).toBe(b.rand());
            }
        });

        test('different seeds produce different sequences', () => {
            const a = new SimpleRNG(1);
            const b = new SimpleRNG(2);
            let same = 0;
            for (let i = 0; i < 100; i++) {
                if (a.rand() === b.rand()) same++;
            }
            expect(same).toBeLessThan(5);
        });
    });

    describe('range', () => {
        test('returns values in [min, max)', () => {
            const rng = new SimpleRNG(42);
            for (let i = 0; i < 1000; i++) {
                const v = rng.range(10, 20);
                expect(v).toBeGreaterThanOrEqual(10);
                expect(v).toBeLessThan(20);
            }
        });

        test('negative ranges work', () => {
            const rng = new SimpleRNG(42);
            for (let i = 0; i < 100; i++) {
                const v = rng.range(-100, -50);
                expect(v).toBeGreaterThanOrEqual(-100);
                expect(v).toBeLessThan(-50);
            }
        });

        test('range with min == max returns min', () => {
            const rng = new SimpleRNG(42);
            expect(rng.range(5, 5)).toBe(5);
        });
    });

    describe('int', () => {
        test('returns integers in [min, max] inclusive', () => {
            const rng = new SimpleRNG(42);
            const seen = new Set<number>();
            for (let i = 0; i < 1000; i++) {
                const v = rng.int(0, 3);
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(3);
                expect(Number.isInteger(v)).toBe(true);
                seen.add(v);
            }
            expect(seen.size).toBe(4); // 0, 1, 2, 3
        });

        test('int(5, 5) always returns 5', () => {
            const rng = new SimpleRNG(42);
            for (let i = 0; i < 10; i++) {
                expect(rng.int(5, 5)).toBe(5);
            }
        });
    });

    describe('chance', () => {
        test('chance(1) always returns true', () => {
            const rng = new SimpleRNG(42);
            for (let i = 0; i < 100; i++) {
                expect(rng.chance(1)).toBe(true);
            }
        });

        test('chance(0) always returns false', () => {
            const rng = new SimpleRNG(42);
            for (let i = 0; i < 100; i++) {
                expect(rng.chance(0)).toBe(false);
            }
        });

        test('chance(0.5) returns roughly half true', () => {
            const rng = new SimpleRNG(42);
            let trues = 0;
            for (let i = 0; i < 10000; i++) {
                if (rng.chance(0.5)) trues++;
            }
            expect(trues).toBeGreaterThan(4000);
            expect(trues).toBeLessThan(6000);
        });
    });

    describe('pick', () => {
        test('picks elements from array', () => {
            const rng = new SimpleRNG(42);
            const arr = ['a', 'b', 'c', 'd'];
            const seen = new Set<string>();
            for (let i = 0; i < 100; i++) {
                seen.add(rng.pick(arr));
            }
            expect(seen.size).toBe(4);
        });

        test('single element array always returns that element', () => {
            const rng = new SimpleRNG(42);
            expect(rng.pick([99])).toBe(99);
        });
    });

    describe('seed', () => {
        test('resetting seed reproduces sequence', () => {
            const rng = new SimpleRNG(42);
            const first = [rng.rand(), rng.rand(), rng.rand()];
            rng.seed(42);
            const second = [rng.rand(), rng.rand(), rng.rand()];
            expect(first).toEqual(second);
        });

        test('seed(0) gets corrected to 1', () => {
            const rng = new SimpleRNG(0);
            const v = rng.rand();
            expect(v).toBeGreaterThan(0); // not stuck at 0
        });
    });

    describe('distribution', () => {
        test('rand is roughly uniform', () => {
            const rng = new SimpleRNG(42);
            const buckets = [0, 0, 0, 0, 0];
            for (let i = 0; i < 50000; i++) {
                const v = rng.rand();
                buckets[(v * 5) | 0]++;
            }
            // Each bucket should be ~10000 ± 1000
            for (const count of buckets) {
                expect(count).toBeGreaterThan(8000);
                expect(count).toBeLessThan(12000);
            }
        });
    });
});

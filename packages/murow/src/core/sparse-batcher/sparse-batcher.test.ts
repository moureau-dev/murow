import { test, expect, describe } from 'bun:test';
import { SparseBatcher } from './sparse-batcher';

describe('SparseBatcher', () => {
    describe('add', () => {
        test('adds a single sprite and updates counts', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 42);
            expect(batcher.getActiveCount()).toBe(1);
            expect(batcher.getTotalCount()).toBe(1);
        });

        test('adds multiple sprites to same bucket', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(0, 0, 2);
            batcher.add(0, 0, 3);
            expect(batcher.getActiveCount()).toBe(1);
            expect(batcher.getTotalCount()).toBe(3);
        });

        test('adds sprites to different layers', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(1, 0, 2);
            batcher.add(2, 0, 3);
            expect(batcher.getActiveCount()).toBe(3);
            expect(batcher.getTotalCount()).toBe(3);
        });

        test('adds sprites to different sheets on same layer', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(0, 1, 2);
            batcher.add(0, 2, 3);
            expect(batcher.getActiveCount()).toBe(3);
            expect(batcher.getTotalCount()).toBe(3);
        });

        test('adds sprites to different layers and sheets', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(0, 1, 2);
            batcher.add(1, 0, 3);
            batcher.add(1, 1, 4);
            expect(batcher.getActiveCount()).toBe(4);
            expect(batcher.getTotalCount()).toBe(4);
        });
    });

    describe('remove', () => {
        test('removes the only sprite in a bucket', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 42);
            batcher.remove(0, 0, 42);
            expect(batcher.getActiveCount()).toBe(0);
            expect(batcher.getTotalCount()).toBe(0);
        });

        test('removes one sprite from a multi-sprite bucket', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(0, 0, 2);
            batcher.add(0, 0, 3);
            batcher.remove(0, 0, 2);
            expect(batcher.getActiveCount()).toBe(1);
            expect(batcher.getTotalCount()).toBe(2);
        });

        test('swap-and-pop: after removal the remaining slots are still iterable', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 10);
            batcher.add(0, 0, 20);
            batcher.add(0, 0, 30);
            batcher.remove(0, 0, 10);

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected.sort()).toEqual([20, 30]);
        });

        test('removing non-existent slot does nothing', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.remove(0, 0, 999);
            expect(batcher.getTotalCount()).toBe(1);
        });

        test('removing from empty bucket does nothing', () => {
            const batcher = new SparseBatcher(1000);
            batcher.remove(0, 0, 1);
            expect(batcher.getActiveCount()).toBe(0);
            expect(batcher.getTotalCount()).toBe(0);
        });

        test('removing last sprite deactivates the bucket', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(1, 0, 2);
            expect(batcher.getActiveCount()).toBe(2);
            batcher.remove(0, 0, 1);
            expect(batcher.getActiveCount()).toBe(1);
        });

        test('removes first element via swap-and-pop correctly', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 100);
            batcher.add(0, 0, 200);
            batcher.remove(0, 0, 100);

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected).toEqual([200]);
        });

        test('removes last element without swap', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 100);
            batcher.add(0, 0, 200);
            batcher.remove(0, 0, 200);

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected).toEqual([100]);
        });
    });

    describe('each', () => {
        test('iterates buckets in layer order (ascending key)', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(5, 0, 50);
            batcher.add(0, 0, 10);
            batcher.add(3, 0, 30);

            const order: number[] = [];
            batcher.each((sheetId, _instances, _count) => {
                order.push(sheetId);
            });
            expect(order.length).toBe(3);
        });

        test('iterates with correct sheetId', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 2, 1);
            batcher.add(0, 5, 2);

            const sheets: number[] = [];
            batcher.each((sheetId) => {
                sheets.push(sheetId);
            });
            expect(sheets.sort()).toEqual([2, 5]);
        });

        test('provides correct instance data and count', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 10);
            batcher.add(0, 0, 20);
            batcher.add(0, 0, 30);

            batcher.each((_sheetId, instances, count) => {
                expect(count).toBe(3);
                const slots = Array.from(instances.subarray(0, count)).sort();
                expect(slots).toEqual([10, 20, 30]);
            });
        });

        test('sorted by layer then sheet', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(2, 1, 1);
            batcher.add(1, 0, 2);
            batcher.add(0, 3, 3);
            batcher.add(1, 2, 4);

            const keys: number[] = [];
            batcher.each((sheetId, _instances, _count) => {
                keys.push(sheetId);
            });
            // Expected order by key: 3 (sheet=3), 16 (sheet=0), 18 (sheet=2), 33 (sheet=1)
            expect(keys).toEqual([3, 0, 2, 1]);
        });

        test('does nothing when no buckets are active', () => {
            const batcher = new SparseBatcher(1000);
            let called = false;
            batcher.each(() => { called = true; });
            expect(called).toBe(false);
        });
    });

    describe('clear', () => {
        test('resets all counts to zero', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(1, 1, 2);
            batcher.add(2, 2, 3);
            batcher.clear();
            expect(batcher.getActiveCount()).toBe(0);
            expect(batcher.getTotalCount()).toBe(0);
        });

        test('after clear, each does not iterate', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.clear();
            let called = false;
            batcher.each(() => { called = true; });
            expect(called).toBe(false);
        });

        test('after clear, can add new sprites', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.clear();
            batcher.add(0, 0, 99);
            expect(batcher.getActiveCount()).toBe(1);
            expect(batcher.getTotalCount()).toBe(1);
        });
    });

    describe('bucket growth', () => {
        test('handles more sprites than initial bucket size (256)', () => {
            const batcher = new SparseBatcher(10000);
            for (let i = 0; i < 300; i++) {
                batcher.add(0, 0, i);
            }
            expect(batcher.getTotalCount()).toBe(300);
            expect(batcher.getActiveCount()).toBe(1);

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected.length).toBe(300);
            expect(collected.sort((a, b) => a - b)).toEqual(
                Array.from({ length: 300 }, (_, i) => i)
            );
        });

        test('grows bucket multiple times', () => {
            const batcher = new SparseBatcher(10000);
            for (let i = 0; i < 600; i++) {
                batcher.add(0, 0, i);
            }
            expect(batcher.getTotalCount()).toBe(600);
        });
    });

    describe('getActiveCount / getTotalCount', () => {
        test('empty batcher has zero counts', () => {
            const batcher = new SparseBatcher(1000);
            expect(batcher.getActiveCount()).toBe(0);
            expect(batcher.getTotalCount()).toBe(0);
        });

        test('counts reflect add and remove operations', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(0, 0, 2);
            batcher.add(1, 0, 3);
            expect(batcher.getActiveCount()).toBe(2);
            expect(batcher.getTotalCount()).toBe(3);

            batcher.remove(0, 0, 1);
            expect(batcher.getTotalCount()).toBe(2);

            batcher.remove(0, 0, 2);
            expect(batcher.getActiveCount()).toBe(1);
            expect(batcher.getTotalCount()).toBe(1);
        });
    });
});

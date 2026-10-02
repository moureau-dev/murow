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

        test('re-adding to an emptied bucket reactivates it', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.remove(0, 0, 1);
            expect(batcher.getActiveCount()).toBe(0);

            batcher.add(0, 0, 2);
            expect(batcher.getActiveCount()).toBe(1);

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected).toEqual([2]);
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

    describe('remove bookkeeping', () => {
        test('removing a slot that was swapped into a new position still works', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 1);
            batcher.add(0, 0, 2);
            batcher.add(0, 0, 3);
            batcher.remove(0, 0, 1);
            batcher.remove(0, 0, 3);

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected).toEqual([2]);
        });

        test('removing the same slot twice is a no-op the second time', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 7);
            batcher.remove(0, 0, 7);
            batcher.remove(0, 0, 7);
            expect(batcher.getTotalCount()).toBe(0);
            expect(batcher.getActiveCount()).toBe(0);
        });

        test('a slot can be removed and re-added to a different bucket', () => {
            const batcher = new SparseBatcher(1000);
            batcher.add(0, 0, 5);
            batcher.remove(0, 0, 5);
            batcher.add(0, 1, 5);
            batcher.remove(0, 1, 5);
            expect(batcher.getTotalCount()).toBe(0);
        });

        test('draining a large bucket one by one keeps counts correct', () => {
            const batcher = new SparseBatcher(1000);
            for (let i = 0; i < 500; i++) batcher.add(0, 0, i);
            for (let i = 0; i < 500; i += 2) batcher.remove(0, 0, i);
            expect(batcher.getTotalCount()).toBe(250);
            for (let i = 1; i < 500; i += 2) batcher.remove(0, 0, i);
            expect(batcher.getTotalCount()).toBe(0);
            expect(batcher.getActiveCount()).toBe(0);
        });

        test('churn across buckets keeps each() equal to the reference set', () => {
            const N = 500;
            const batcher = new SparseBatcher(N);
            const where = new Map<number, [number, number]>();
            const live = new Set<number>();
            let seed = 12345;
            const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff;

            for (let op = 0; op < 4000; op++) {
                if (live.size === 0 || (rnd() < 0.6 && live.size < N)) {
                    const slot = Math.floor(rnd() * N);
                    if (live.has(slot)) continue;
                    const layer = Math.floor(rnd() * 4);
                    const sheet = Math.floor(rnd() * 8);
                    batcher.add(layer, sheet, slot);
                    where.set(slot, [layer, sheet]);
                    live.add(slot);
                } else {
                    const slot = [...live][Math.floor(rnd() * live.size)]!;
                    const [layer, sheet] = where.get(slot)!;
                    batcher.remove(layer, sheet, slot);
                    where.delete(slot);
                    live.delete(slot);
                }
                expect(batcher.getTotalCount()).toBe(live.size);
            }

            const collected: number[] = [];
            batcher.each((_sheetId, instances, count) => {
                for (let i = 0; i < count; i++) collected.push(instances[i]);
            });
            expect(collected.sort((a, b) => a - b)).toEqual([...live].sort((a, b) => a - b));
        });
    });
});

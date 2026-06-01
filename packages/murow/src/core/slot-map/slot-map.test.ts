import { test, expect, describe } from 'bun:test';
import { SlotMap, SlotStore } from './slot-map';

/** Collect the live slots into a plain sorted array for order-independent checks. */
function liveSlots(map: SlotMap): number[] {
    const out: number[] = [];
    const active = map.activeSlots;
    for (let i = 0; i < map.size; i++) out.push(active[i]!);
    return out.sort((a, b) => a - b);
}

describe('SlotMap', () => {
    describe('add', () => {
        test('allocates a slot and grows size', () => {
            const map = new SlotMap(8);
            const slot = map.add();
            expect(slot).not.toBe(-1);
            expect(map.size).toBe(1);
            expect(map.has(slot)).toBe(true);
        });

        test('allocates distinct slots', () => {
            const map = new SlotMap(8);
            const a = map.add();
            const b = map.add();
            const c = map.add();
            expect(new Set([a, b, c]).size).toBe(3);
            expect(map.size).toBe(3);
        });

        test('returns -1 when exhausted and leaves size at capacity', () => {
            const map = new SlotMap(2);
            map.add();
            map.add();
            expect(map.hasAvailable()).toBe(false);
            expect(map.add()).toBe(-1);
            expect(map.size).toBe(2);
        });
    });

    describe('remove', () => {
        test('removes the only slot', () => {
            const map = new SlotMap(8);
            const slot = map.add();
            map.remove(slot);
            expect(map.size).toBe(0);
            expect(map.has(slot)).toBe(false);
        });

        test('removes the last live slot without disturbing others', () => {
            const map = new SlotMap(8);
            const a = map.add();
            const b = map.add();
            const c = map.add();
            map.remove(c);
            expect(map.size).toBe(2);
            expect(liveSlots(map)).toEqual([a, b].sort((x, y) => x - y));
            expect(map.has(c)).toBe(false);
        });

        test('removes a middle slot and keeps the dense array packed', () => {
            const map = new SlotMap(8);
            const a = map.add();
            const b = map.add();
            const c = map.add();
            map.remove(b);
            expect(map.size).toBe(2);
            expect(liveSlots(map)).toEqual([a, c].sort((x, y) => x - y));
            expect(map.has(b)).toBe(false);
            // a and c are both still resolvable / iterable
            expect(map.has(a)).toBe(true);
            expect(map.has(c)).toBe(true);
        });

        test('removing an absent slot is a no-op', () => {
            const map = new SlotMap(8);
            const a = map.add();
            map.remove(a);
            expect(() => map.remove(a)).not.toThrow();
            expect(map.size).toBe(0);
        });

        test('removing a never-allocated slot is a no-op', () => {
            const map = new SlotMap(8);
            expect(() => map.remove(5)).not.toThrow();
            expect(map.size).toBe(0);
        });
    });

    describe('reuse', () => {
        test('a freed slot becomes available again', () => {
            const map = new SlotMap(2);
            const a = map.add();
            const b = map.add();
            expect(map.hasAvailable()).toBe(false);
            map.remove(a);
            expect(map.hasAvailable()).toBe(true);
            const c = map.add();
            expect(c).not.toBe(-1);
            expect(map.size).toBe(2);
            expect(map.has(b)).toBe(true);
            expect(map.has(c)).toBe(true);
        });

        test('survives an add/remove churn cycle with consistent membership', () => {
            const map = new SlotMap(16);
            const live = new Set<number>();
            for (let round = 0; round < 100; round++) {
                if (map.hasAvailable() && (round % 3 !== 0 || live.size === 0)) {
                    const s = map.add();
                    live.add(s);
                } else {
                    const s = live.values().next().value as number;
                    map.remove(s);
                    live.delete(s);
                }
                expect(map.size).toBe(live.size);
                for (const s of live) expect(map.has(s)).toBe(true);
            }
        });
    });

    describe('iteration', () => {
        test('forEach visits every live slot exactly once', () => {
            const map = new SlotMap(8);
            const added = [map.add(), map.add(), map.add()];
            const seen: number[] = [];
            map.forEach((slot) => seen.push(slot));
            expect(seen.sort((a, b) => a - b)).toEqual(added.sort((a, b) => a - b));
        });

        test('activeSlots and size agree after removals', () => {
            const map = new SlotMap(8);
            map.add();
            const b = map.add();
            map.add();
            map.remove(b);
            const collected = liveSlots(map);
            expect(collected.length).toBe(map.size);
            expect(collected).not.toContain(b);
        });
    });

    describe('clear', () => {
        test('empties the set and frees every slot', () => {
            const map = new SlotMap(4);
            map.add();
            map.add();
            map.clear();
            expect(map.size).toBe(0);
            expect(map.hasAvailable()).toBe(true);
            // full capacity is reclaimed
            expect(map.add()).not.toBe(-1);
            expect(map.add()).not.toBe(-1);
            expect(map.add()).not.toBe(-1);
            expect(map.add()).not.toBe(-1);
            expect(map.add()).toBe(-1);
        });
    });

    test('capacity reflects the constructor argument', () => {
        expect(new SlotMap(123).capacity).toBe(123);
    });
});

describe('SlotStore', () => {
    describe('add / get', () => {
        test('stores and retrieves an item by external id', () => {
            const store = new SlotStore<number, string>(8, 64);
            store.add(42, 'hello');
            expect(store.get(42)).toBe('hello');
            expect(store.has(42)).toBe(true);
            expect(store.size).toBe(1);
        });

        test('external id need not equal the slot', () => {
            const store = new SlotStore<number, string>(8);
            // ids are sparse within the id space
            store.add(7, 'a');
            store.add(0, 'b');
            store.add(3, 'c');
            expect(store.get(7)).toBe('a');
            expect(store.get(0)).toBe('b');
            expect(store.get(3)).toBe('c');
        });

        test('id space can exceed capacity (archetype keyed by entity id)', () => {
            // only 4 live at once, but ids are drawn from a 1000-entity space
            const store = new SlotStore<number, string>(4, 1000);
            store.add(900, 'a');
            store.add(5, 'b');
            store.add(999, 'c');
            store.add(0, 'd');
            expect(store.size).toBe(4);
            expect(store.get(900)).toBe('a');
            expect(store.get(999)).toBe('c');
            expect(() => store.add(1, 'e')).toThrow();        // capacity reached
            store.remove(900);
            expect(() => store.add(1, 'e')).not.toThrow();    // slot freed
        });

        test('throws on an id outside the id space', () => {
            const store = new SlotStore<number, string>(8, 16);
            expect(() => store.add(16, 'x')).toThrow();
            expect(() => store.add(-1, 'x')).toThrow();
        });

        test('out-of-range lookups are safe', () => {
            const store = new SlotStore<number, string>(8, 16);
            expect(store.get(100)).toBeNull();
            expect(store.has(100)).toBe(false);
            expect(store.slotOf(100)).toBe(-1);
            expect(() => store.remove(100)).not.toThrow();
        });

        test('get returns null for an absent id', () => {
            const store = new SlotStore<number, string>(8);
            expect(store.get(5)).toBeNull();
            expect(store.has(5)).toBe(false);
        });

        test('throws on duplicate id', () => {
            const store = new SlotStore<number, string>(8);
            store.add(1, 'x');
            expect(() => store.add(1, 'y')).toThrow();
        });

        test('throws when capacity is reached', () => {
            const store = new SlotStore<number, string>(2);
            store.add(0, 'a');
            store.add(1, 'b');
            expect(() => store.add(2, 'c')).toThrow();
        });
    });

    describe('remove', () => {
        test('removes by id', () => {
            const store = new SlotStore<number, string>(8, 16);
            store.add(9, 'x');
            store.remove(9);
            expect(store.has(9)).toBe(false);
            expect(store.get(9)).toBeNull();
            expect(store.size).toBe(0);
        });

        test('removing an absent id is a no-op', () => {
            const store = new SlotStore<number, string>(8);
            expect(() => store.remove(3)).not.toThrow();
            expect(store.size).toBe(0);
        });

        test('removing a middle id keeps the rest retrievable', () => {
            const store = new SlotStore<number, string>(8);
            store.add(1, 'a');
            store.add(2, 'b');
            store.add(3, 'c');
            store.remove(2);
            expect(store.get(1)).toBe('a');
            expect(store.get(3)).toBe('c');
            expect(store.get(2)).toBeNull();
            expect(store.size).toBe(2);
        });

        test('id is reusable after removal', () => {
            const store = new SlotStore<number, string>(8);
            store.add(4, 'first');
            store.remove(4);
            expect(() => store.add(4, 'second')).not.toThrow();
            expect(store.get(4)).toBe('second');
        });
    });

    describe('iteration', () => {
        test('forEach reports item, id and slot for each entry', () => {
            const store = new SlotStore<number, string>(8, 64);
            store.add(10, 'a');
            store.add(20, 'b');
            const byId = new Map<number, string>();
            const slots = new Set<number>();
            store.forEach((item, id, slot) => {
                byId.set(id, item);
                slots.add(slot);
                expect(store.slotOf(id)).toBe(slot);
            });
            expect(byId.get(10)).toBe('a');
            expect(byId.get(20)).toBe('b');
            expect(slots.size).toBe(2);
        });

        test('forEach stays correct after a middle removal', () => {
            const store = new SlotStore<number, number>(8);
            store.add(1, 100);
            store.add(2, 200);
            store.add(3, 300);
            store.remove(2);
            const seen: number[] = [];
            store.forEach((item, id) => seen.push(id));
            expect(seen.sort((a, b) => a - b)).toEqual([1, 3]);
        });
    });

    describe('clear', () => {
        test('empties the store and reclaims capacity', () => {
            const store = new SlotStore<number, string>(2);
            store.add(0, 'a');
            store.add(1, 'b');
            store.clear();
            expect(store.size).toBe(0);
            expect(store.get(0)).toBeNull();
            expect(store.has(1)).toBe(false);
            expect(() => store.add(0, 'c')).not.toThrow();
            expect(() => store.add(1, 'd')).not.toThrow();
        });
    });

    test('slotOf returns -1 for an absent id', () => {
        const store = new SlotStore<number, string>(8);
        expect(store.slotOf(2)).toBe(-1);
    });
});

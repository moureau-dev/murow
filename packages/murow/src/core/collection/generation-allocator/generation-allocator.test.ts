import { test, expect, describe } from 'bun:test';
import { GenerationAllocator } from './generation-allocator';

describe('GenerationAllocator', () => {
    test('alloc returns ids that decode to their slot', () => {
        const a = new GenerationAllocator(4);
        const id0 = a.allocate();
        const id1 = a.allocate();
        expect(a.slotOf(id0)).toBe(id0);
        expect(id0).not.toBe(id1);
        expect(a.isLive(id0)).toBe(true);
        expect(a.size).toBe(2);
    });

    test('reusing a slot bumps the generation and the old id goes stale', () => {
        const a = new GenerationAllocator(4);
        const id = a.allocate();
        const slot = a.slotOf(id);
        a.free(id);
        expect(a.isLive(id)).toBe(false);

        const reused = a.allocate();
        expect(a.slotOf(reused)).toBe(slot);
        expect(reused).not.toBe(id);
        expect(a.isLive(reused)).toBe(true);
        expect(a.isLive(id)).toBe(false);
    });

    test('exhaustion returns -1', () => {
        const a = new GenerationAllocator(2);
        a.allocate();
        a.allocate();
        expect(a.allocate()).toBe(-1);
        expect(a.hasAvailable()).toBe(false);
    });

    test('clear makes outstanding ids stale and frees the pool', () => {
        const a = new GenerationAllocator(2);
        const id = a.allocate();
        a.clear();
        expect(a.isLive(id)).toBe(false);
        expect(a.size).toBe(0);
        expect(a.hasAvailable()).toBe(true);
        expect(a.isLive(a.allocate())).toBe(true);
    });

    test('out-of-range ids are not live', () => {
        const a = new GenerationAllocator(4);
        const id = a.allocate();
        expect(a.isLive(id + 1000)).toBe(false);
        expect(a.isLive(-1)).toBe(false);
    });

    test('zero capacity is safe', () => {
        const a = new GenerationAllocator(0);
        expect(a.allocate()).toBe(-1);
        expect(a.isLive(0)).toBe(false);
        expect(a.slotOf(0)).toBe(-1);
    });
});

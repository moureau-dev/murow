import { test, expect } from 'bun:test';
import { HitBuffer } from './hit-buffer';

type H = { id: number };

function buf(): HitBuffer<H, [number, number, number]> {
    return new HitBuffer<H, [number, number, number]>(3);
}

function seed(b: HitBuffer<H, [number, number, number]>, keys: number[]): void {
    b.reset();
    keys.forEach((k, i) => b.push({ id: i }, k, 0, 0, k));
}

test('nearest returns the closest within cap, respecting filter', () => {
    const b = buf();
    seed(b, [5, 2, 8]);

    expect(b.nearest(undefined, Infinity)!.distance).toBe(2);
    expect(b.nearest(undefined, 4)!.distance).toBe(2);
    expect(b.nearest((h) => h.id !== 1, Infinity)!.distance).toBe(5);
    expect(b.nearest(undefined, 1)).toBeNull();
});

test('stores the point the backend pushed', () => {
    const b = buf();
    b.reset();
    b.push({ id: 0 }, 4, 1, 2, 7);
    expect(b.nearest(undefined, Infinity)!.point).toEqual([1, 2, 7]);
});

test('collectInto yields hits nearest-first and stops at cap', () => {
    const b = buf();
    seed(b, [5, 2, 8]);

    const out: any[] = [];
    b.collectInto(out, undefined, Infinity);
    expect(out.map((h) => h.distance)).toEqual([2, 5, 8]);

    const capped: any[] = [];
    b.collectInto(capped, undefined, 6);
    expect(capped.map((h) => h.distance)).toEqual([2, 5]);
});

test('nearest result is not aliased by a later collectInto', () => {
    const b = buf();
    seed(b, [5, 2, 8]);

    const near = b.nearest(undefined, Infinity)!;
    const distBefore = near.distance;
    const out: any[] = [];
    b.collectInto(out, undefined, Infinity);
    expect(near.distance).toBe(distBefore);
});

test('nearest tie-break takes the first matching slot', () => {
    const b = buf();
    seed(b, [4, 4, 4]);
    expect(b.nearest(undefined, Infinity)!.handle.id).toBe(0);
});

test('a push after a sorted query re-sorts on the next query', () => {
    const b = buf();
    seed(b, [5, 2]);

    const first: any[] = [];
    b.collectInto(first, undefined, Infinity);
    expect(first.map((h) => h.distance)).toEqual([2, 5]);

    b.push({ id: 99 }, 1, 0, 0, 1);
    const second: any[] = [];
    b.collectInto(second, undefined, Infinity);
    expect(second.map((h) => h.distance)).toEqual([1, 2, 5]);
});

test('collectInto reuses caller objects and survives a reset', () => {
    const b = buf();
    seed(b, [5, 2]);

    const durable: any[] = [];
    b.collectInto(durable, undefined, Infinity);
    expect(durable.map((h) => h.distance)).toEqual([2, 5]);
    const firstObj = durable[0];

    seed(b, [9, 1, 3]);
    b.collectInto(durable, undefined, Infinity);
    expect(durable.map((h) => h.distance)).toEqual([1, 3, 9]);
    expect(durable[0]).toBe(firstObj);
});

test('containsId scans the live hit set only', () => {
    const b = buf();
    seed(b, [5, 2, 8]);
    expect(b.containsId(1)).toBe(true);
    expect(b.containsId(99)).toBe(false);

    b.reset();
    expect(b.containsId(1)).toBe(false);
});

test('2D buffer leaves the z coord untouched', () => {
    const b2 = new HitBuffer<H, [number, number]>(2);
    b2.reset();
    b2.push({ id: 0 }, 3, 4, 5);
    const hit = b2.nearest(undefined, Infinity)!;
    expect(hit.point).toEqual([4, 5]);
});

test('orders by key but reports the separate distance value', () => {
    const b2 = new HitBuffer<H, [number, number]>(2);
    b2.reset();
    // Topmost-first ordering via -layer keys; exposed distance is the real layer.
    b2.push({ id: 0 }, -2, 0, 0, 0, 2);
    b2.push({ id: 1 }, -7, 0, 0, 0, 7);
    b2.push({ id: 0 }, -5, 0, 0, 0, 5);

    const top = b2.nearest(undefined, Infinity)!;
    expect(top.handle.id).toBe(1);   // layer 7 wins (smallest key)
    expect(top.distance).toBe(7);    // honest layer, not -7

    const out: any[] = [];
    b2.collectInto(out, undefined, Infinity);
    expect(out.map((h) => h.distance)).toEqual([7, 5, 2]);
});

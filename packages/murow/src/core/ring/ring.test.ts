import { test, expect, describe } from 'bun:test';
import { Ring } from './ring';
import { RingStore } from './ring-store';
import { RingBuffer } from './ring-buffer';

describe('Ring', () => {
    test('starts empty', () => {
        const r = new Ring(3);
        expect(r.size).toBe(0);
        expect(r.capacity).toBe(3);
        expect(r.isFull).toBe(false);
    });

    test('fills in insertion order', () => {
        const r = new Ring(3);
        r.push(10);
        r.push(20);
        r.push(30);
        expect(r.size).toBe(3);
        expect(r.isFull).toBe(true);
        expect([r.at(0), r.at(1), r.at(2)]).toEqual([10, 20, 30]);
        expect(r.oldest()).toBe(10);
        expect(r.newest()).toBe(30);
    });

    test('overwrites the oldest when full', () => {
        const r = new Ring(3);
        r.push(1); r.push(2); r.push(3);
        r.push(4);
        expect(r.size).toBe(3);
        expect([r.at(0), r.at(1), r.at(2)]).toEqual([2, 3, 4]);
        expect(r.oldest()).toBe(2);
        expect(r.newest()).toBe(4);
    });

    test('wraps physical slots but keeps order', () => {
        const r = new Ring(2);
        expect(r.push(1)).toBe(0);
        expect(r.push(2)).toBe(1);
        expect(r.push(3)).toBe(0);
        expect([r.slotAt(0), r.slotAt(1)]).toEqual([1, 0]);
        expect([r.at(0), r.at(1)]).toEqual([2, 3]);
    });

    test('forEach visits oldest to newest', () => {
        const r = new Ring(3);
        r.push(1); r.push(2); r.push(3); r.push(4);
        const seen: number[] = [];
        r.forEach((v) => seen.push(v));
        expect(seen).toEqual([2, 3, 4]);
    });

    test('clear resets', () => {
        const r = new Ring(2);
        r.push(1); r.push(2);
        r.clear();
        expect(r.size).toBe(0);
        expect(r.isFull).toBe(false);
    });
});

interface Rec { id: number; x: number; }

describe('RingStore', () => {
    const make = () => new RingStore<Rec>({ capacity: 3, create: () => ({ id: 0, x: 0 }) });

    test('reuses the same slot objects (no allocation on push)', () => {
        const store = make();
        const s0 = store.push();
        const first = store.get(s0);
        first.id = 7;
        // Fill the remaining slots, then push once more to recycle slot 0.
        store.push();
        store.push();
        const s = store.push();
        expect(s).toBe(s0);
        expect(store.get(s)).toBe(first);
    });

    test('overwrites oldest and preserves order', () => {
        const store = make();
        for (let i = 1; i <= 4; i++) store.get(store.push()).id = i;
        const ids: number[] = [];
        store.forEach((rec) => ids.push(rec.id));
        expect(ids).toEqual([2, 3, 4]);
        expect(store.oldest().id).toBe(2);
        expect(store.newest().id).toBe(4);
    });

    test('clear resets without dropping objects', () => {
        const store = make();
        const item = store.get(store.push());
        store.push();
        store.clear();
        expect(store.size).toBe(0);
        expect(store.get(store.push())).toBe(item);
    });
});

describe('RingBuffer', () => {
    test('reserves slots and reports offsets', () => {
        const buf = new RingBuffer({ capacity: 2, stride: 4 });
        expect(buf.bytes.length).toBe(8);
        expect(buf.push()).toBe(0);
        expect(buf.push()).toBe(1);
        expect(buf.offsetOf(1)).toBe(4);
    });

    test('overwrites oldest and iterates in order', () => {
        const buf = new RingBuffer({ capacity: 2, stride: 4 });
        for (let i = 1; i <= 3; i++) {
            const slot = buf.push();
            new DataView(buf.bytes.buffer).setUint32(buf.offsetOf(slot), i, true);
        }
        const view = new DataView(buf.bytes.buffer);
        const seen: number[] = [];
        buf.forEach((off) => seen.push(view.getUint32(off, true)));
        expect(seen).toEqual([2, 3]);
        expect(buf.oldestSlot()).toBe(1);
        expect(buf.newestSlot()).toBe(0);
    });

    test('accepts an external backing array', () => {
        const bytes = new Uint8Array(16);
        const buf = new RingBuffer({ capacity: 4, stride: 4, bytes });
        expect(buf.bytes).toBe(bytes);
    });
});

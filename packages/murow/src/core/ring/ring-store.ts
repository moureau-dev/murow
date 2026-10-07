/**
 * Fixed-capacity ring of objects. Every slot's object is created once by the
 * supplied factory and reused forever, so `push()` never allocates.
 *
 * Typical use is a pool of transient records (decals, trails, floating text):
 * `push()` hands you the slot to overwrite, and wrapping past capacity silently
 * recycles the oldest. For raw `u32` values use `Ring`; for bytes use
 * `RingBuffer`.
 */
export interface RingStoreOptions<T> {
    /** Fixed number of reusable slots. */
    capacity: number;
    /** Called once per slot at construction; the returned object is reused. */
    create: () => T;
}

export class RingStore<T> {
    private readonly items: T[];
    private readonly capacityValue: number;
    /** Physical index of the oldest live entry. */
    private head = 0;
    private count = 0;

    constructor({ capacity, create }: RingStoreOptions<T>) {
        this.capacityValue = capacity;
        this.items = new Array<T>(capacity);
        for (let i = 0; i < capacity; i++) this.items[i] = create();
    }

    get capacity(): number { return this.capacityValue; }
    get size(): number { return this.count; }
    get isFull(): boolean { return this.count === this.capacityValue; }

    /**
     * Reserve the newest slot, overwriting the oldest when full.
     * Returns the slot; mutate `get(slot)` in place.
     */
    push(): number {
        let slot: number;
        if (this.count < this.capacityValue) {
            slot = (this.head + this.count) % this.capacityValue;
            this.count++;
        } else {
            slot = this.head;
            this.head = (this.head + 1) % this.capacityValue;
        }
        return slot;
    }

    /** The object stored at a physical slot. */
    get(slot: number): T {
        return this.items[slot]!;
    }

    /** Physical slot of the i-th oldest entry (0 = oldest). */
    slotAt(i: number): number {
        return (this.head + i) % this.capacityValue;
    }

    /** The i-th oldest entry. */
    at(i: number): T {
        return this.items[this.slotAt(i)]!;
    }

    oldestSlot(): number { return this.head; }
    oldest(): T { return this.items[this.head]!; }
    newestSlot(): number { return this.slotAt(this.count - 1); }
    newest(): T { return this.items[this.slotAt(this.count - 1)]!; }

    clear(): void {
        this.head = 0;
        this.count = 0;
    }

    /** Iterate oldest to newest; `slot` is the reusable physical slot. */
    forEach(cb: (item: T, slot: number, i: number) => void): void {
        for (let i = 0; i < this.count; i++) {
            const slot = this.slotAt(i);
            cb(this.items[slot]!, slot, i);
        }
    }
}

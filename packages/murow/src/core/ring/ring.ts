/**
 * Fixed-capacity ring of `u32` values. Pushing past capacity overwrites the
 * oldest value. Zero-GC: nothing is allocated after construction.
 *
 * Use when the newest N ids/flags matter and older ones can be dropped
 * (voice stealing, "recently seen" sets). For objects use `RingStore`; for raw
 * bytes use `RingBuffer`.
 */
export class Ring {
    private readonly values: Uint32Array;
    private readonly capacityValue: number;
    /** Physical index of the oldest live entry. */
    private head = 0;
    private count = 0;

    constructor(capacity: number) {
        this.capacityValue = capacity;
        this.values = new Uint32Array(capacity);
    }

    get capacity(): number { return this.capacityValue; }
    get size(): number { return this.count; }
    get isFull(): boolean { return this.count === this.capacityValue; }

    /**
     * Write `value` as the newest entry, overwriting the oldest when full.
     * Returns the physical slot it landed in.
     */
    push(value: number): number {
        let slot: number;
        if (this.count < this.capacityValue) {
            slot = (this.head + this.count) % this.capacityValue;
            this.count++;
        } else {
            slot = this.head;
            this.head = (this.head + 1) % this.capacityValue;
        }
        this.values[slot] = value;
        return slot;
    }

    /** Physical slot of the i-th oldest entry (0 = oldest). */
    slotAt(i: number): number {
        return (this.head + i) % this.capacityValue;
    }

    /** Value of the i-th oldest entry. */
    at(i: number): number {
        return this.values[this.slotAt(i)]!;
    }

    oldest(): number { return this.values[this.head]!; }
    newest(): number { return this.values[this.slotAt(this.count - 1)]!; }

    clear(): void {
        this.head = 0;
        this.count = 0;
    }

    /** Iterate oldest to newest. */
    forEach(cb: (value: number, i: number) => void): void {
        for (let i = 0; i < this.count; i++) {
            cb(this.values[this.slotAt(i)]!, i);
        }
    }
}

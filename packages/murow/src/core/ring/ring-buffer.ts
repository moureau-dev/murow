/**
 * Fixed-capacity ring of fixed-stride byte records. Pushing past capacity
 * overwrites the oldest record. The backing `Uint8Array` is reused, so a
 * consumer (e.g. lag-compensation frames, input history) can write into the
 * returned slot's region with typed views and never allocate.
 */
export interface RingBufferOptions {
    /** Fixed number of records. */
    capacity: number;
    /** Bytes per record. */
    stride: number;
    /** Optional external backing array (must be at least `capacity * stride`). */
    bytes?: Uint8Array;
}

export class RingBuffer {
    /** Backing storage; valid bytes for a slot are `offsetOf(slot) .. +stride`. */
    readonly bytes: Uint8Array;
    private readonly capacityValue: number;
    private readonly strideValue: number;
    /** Fast wrap when capacity is a power of two (`& mask` beats `%`). */
    private readonly mask: number;
    private readonly isPow2: boolean;
    /** Physical index of the oldest live record. */
    private head = 0;
    private count = 0;

    constructor({ capacity, stride, bytes }: RingBufferOptions) {
        this.capacityValue = capacity;
        this.strideValue = stride;
        this.isPow2 = (capacity & (capacity - 1)) === 0;
        this.mask = this.isPow2 ? capacity - 1 : 0;
        this.bytes = bytes ?? new Uint8Array(capacity * stride);
    }

    private wrap(i: number): number {
        return this.isPow2 ? (i & this.mask) : (i % this.capacityValue);
    }

    get capacity(): number { return this.capacityValue; }
    get stride(): number { return this.strideValue; }
    get size(): number { return this.count; }
    get isFull(): boolean { return this.count === this.capacityValue; }

    /** Reserve the newest slot, overwriting the oldest when full. */
    push(): number {
        let slot: number;
        if (this.count < this.capacityValue) {
            slot = this.wrap(this.head + this.count);
            this.count++;
        } else {
            slot = this.head;
            this.head = this.wrap(this.head + 1);
        }
        return slot;
    }

    /** Byte offset of a slot's record inside `bytes`. */
    offsetOf(slot: number): number {
        return slot * this.strideValue;
    }

    /** Physical slot of the i-th oldest record (0 = oldest). */
    slotAt(i: number): number {
        return this.wrap(this.head + i);
    }

    /** Byte offset of the i-th oldest record. */
    offsetAt(i: number): number {
        return this.offsetOf(this.slotAt(i));
    }

    oldestSlot(): number { return this.head; }
    newestSlot(): number { return this.slotAt(this.count - 1); }
    oldestOffset(): number { return this.offsetOf(this.head); }
    newestOffset(): number { return this.offsetAt(this.count - 1); }

    clear(): void {
        this.head = 0;
        this.count = 0;
    }

    /** Iterate oldest to newest; `offset` is the record's byte offset. */
    forEach(cb: (offset: number, slot: number, i: number) => void): void {
        for (let i = 0; i < this.count; i++) {
            const slot = this.slotAt(i);
            cb(this.offsetOf(slot), slot, i);
        }
    }
}

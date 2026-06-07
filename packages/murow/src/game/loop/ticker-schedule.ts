import { SlotMap } from "../../core";

const NOOP = () => {};

interface Schedule {
    interval: number;
    next: number;
    cb: () => void;
    cancelled: boolean;
}

/**
 * Fixed-capacity, zero-GC scheduler of tick-interval callbacks for the game loop.
 *
 * Schedules are stored in a pre-allocated object pool indexed by a {@link SlotMap}
 * slot, so registering and cancelling reuse objects instead of producing garbage.
 * Ids returned by {@link every} pack the slot with a generation counter, so an id
 * left over from a cancelled schedule can never cancel the schedule that later
 * reuses its slot.
 */
export class TickerSchedule {
    private readonly _capacity: number;
    private readonly _slots: SlotMap;
    private readonly _generations: Uint32Array;
    private readonly _pool: Schedule[];
    private _dirty = false;
    private _running = false;

    constructor(capacity: number) {
        this._capacity = Math.max(1, Math.floor(capacity));
        this._slots = new SlotMap(this._capacity);
        this._generations = new Uint32Array(this._capacity);
        this._pool = new Array<Schedule>(this._capacity);
        for (let i = 0; i < this._capacity; i++) {
            this._pool[i] = { interval: 0, next: 0, cb: NOOP, cancelled: false };
        }
    }

    /**
     * Number of live schedules.
     */
    get size(): number {
        return this._slots.size;
    }

    /**
     * Maximum number of simultaneously live schedules.
     */
    get capacity(): number {
        return this._capacity;
    }

    /**
     * Registers a callback to fire every `intervalTicks`, starting `intervalTicks`
     * after `currentTick`. Returns a stable id for {@link clear}, or `-1` if the
     * scheduler is at capacity.
     */
    every(intervalTicks: number, cb: () => void, currentTick: number): number {
        if (this._dirty && !this._running) this._compact();

        const slot = this._slots.add();
        if (slot === -1) return -1;

        const schedule = this._pool[slot];
        schedule.interval = Math.max(1, Math.round(intervalTicks));
        schedule.next = currentTick + schedule.interval;
        schedule.cb = cb;
        schedule.cancelled = false;

        return slot + this._generations[slot] * this._capacity;
    }

    /**
     * Cancels the schedule for `id`. No-op (returns `false`) if the id is stale,
     * unknown, or already cancelled.
     */
    clear(id: number): boolean {
        const slot = id % this._capacity;
        if (slot < 0 || !this._slots.has(slot)) return false;
        if (this._generations[slot] !== (id - slot) / this._capacity) return false;

        this._pool[slot].cancelled = true;
        this._generations[slot]++;
        this._dirty = true;
        if (!this._running) this._compact();
        return true;
    }

    /**
     * Cancels every live schedule.
     */
    clearAll(): void {
        const active = this._slots.activeSlots;
        const count = this._slots.size;
        for (let i = 0; i < count; i++) {
            const slot = active[i];
            this._pool[slot].cancelled = true;
            this._generations[slot]++;
        }
        this._dirty = true;
        if (!this._running) this._compact();
    }

    /**
     * Fires every schedule whose interval has elapsed at `currentTick`, then
     * realigns it relative to `currentTick` (a long frame fires once, not a burst).
     */
    run(currentTick: number): void {
        if (this._dirty) this._compact();

        this._running = true;
        const active = this._slots.activeSlots;
        const count = this._slots.size;
        for (let i = 0; i < count; i++) {
            const schedule = this._pool[active[i]];
            if (schedule.cancelled) continue;
            if (currentTick >= schedule.next) {
                schedule.next = currentTick + schedule.interval;
                schedule.cb();
            }
        }
        this._running = false;

        if (this._dirty) this._compact();
    }

    /**
     * Re-anchors every live schedule's next fire relative to `baseTick`. Called
     * when the loop restarts and the tick count resets.
     */
    rebase(baseTick: number): void {
        if (this._dirty) this._compact();

        const active = this._slots.activeSlots;
        const count = this._slots.size;
        for (let i = 0; i < count; i++) {
            const schedule = this._pool[active[i]];
            schedule.next = baseTick + schedule.interval;
        }
    }

    private _compact(): void {
        const slots = this._slots;
        let i = 0;
        while (i < slots.size) {
            const slot = slots.activeSlots[i];
            if (this._pool[slot].cancelled) {
                this._pool[slot].cb = NOOP;
                this._pool[slot].cancelled = false;
                slots.remove(slot);
            } else {
                i++;
            }
        }
        this._dirty = false;
    }
}

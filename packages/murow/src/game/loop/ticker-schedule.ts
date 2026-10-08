import { GenerationAllocator } from '../../core/collection';

const NOOP = () => {};

interface Schedule {
    interval: number;
    next: number;
    cb: () => void;
    repeat: boolean;
    cancelled: boolean;
}

/**
 * Fixed-capacity, zero-GC scheduler of tick-timed callbacks for the game loop.
 *
 * Schedules are stored in a pre-allocated object pool indexed by a slot, so
 * registering and cancelling reuse objects instead of producing garbage. Ids are
 * generation-versioned ({@link GenerationAllocator}), so an id left over from a
 * finished schedule can never cancel the schedule that later reuses its slot.
 */
export class TickerSchedule {
    private readonly _capacity: number;
    private readonly _alloc: GenerationAllocator;
    /** slot -> live id, so compaction can free by id. */
    private readonly _ids: Int32Array;
    private readonly _pool: Schedule[];
    private _dirty = false;
    private _running = false;

    constructor(capacity: number) {
        this._capacity = Math.max(1, Math.floor(capacity));
        this._alloc = new GenerationAllocator(this._capacity);
        this._ids = new Int32Array(this._capacity).fill(-1);
        this._pool = new Array<Schedule>(this._capacity);
        for (let i = 0; i < this._capacity; i++) {
            this._pool[i] = { interval: 0, next: 0, cb: NOOP, repeat: true, cancelled: false };
        }
    }

    /**
     * Number of live schedules.
     */
    get size(): number {
        return this._alloc.size;
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

        const id = this._alloc.allocate();
        if (id === -1) return -1;
        const slot = this._alloc.slotOf(id);
        this._ids[slot] = id;

        const schedule = this._pool[slot];
        schedule.interval = Math.max(1, Math.round(intervalTicks));
        schedule.next = currentTick + schedule.interval;
        schedule.cb = cb;
        schedule.repeat = true;
        schedule.cancelled = false;

        return id;
    }

    /**
     * Registers a callback to fire once, `delayTicks` after `currentTick`. The
     * schedule removes itself after firing and its id becomes stale. Returns an
     * id for {@link clear}, or `-1` if the scheduler is at capacity.
     */
    in(delayTicks: number, cb: () => void, currentTick: number): number {
        if (this._dirty && !this._running) this._compact();

        const id = this._alloc.allocate();
        if (id === -1) return -1;
        const slot = this._alloc.slotOf(id);
        this._ids[slot] = id;

        const schedule = this._pool[slot];
        schedule.interval = Math.max(1, Math.round(delayTicks));
        schedule.next = currentTick + schedule.interval;
        schedule.cb = cb;
        schedule.repeat = false;
        schedule.cancelled = false;

        return id;
    }

    /**
     * Cancels the schedule for `id`. No-op (returns `false`) if the id is stale,
     * unknown, or already cancelled.
     */
    clear(id: number): boolean {
        if (!this._alloc.isLive(id)) return false;
        const slot = this._alloc.slotOf(id);
        const schedule = this._pool[slot];
        if (schedule.cancelled) return false;

        schedule.cancelled = true;
        this._dirty = true;
        if (!this._running) this._compact();
        return true;
    }

    /**
     * Cancels every live schedule.
     */
    clearAll(): void {
        const active = this._alloc.activeSlots;
        const count = this._alloc.size;
        for (let i = 0; i < count; i++) {
            this._pool[active[i]!]!.cancelled = true;
        }
        this._dirty = true;
        if (!this._running) this._compact();
    }

    /**
     * Fires every schedule due at `currentTick`. Repeating schedules realign
     * relative to `currentTick` (a long frame fires once, not a burst); one-shot
     * schedules are removed after firing.
     */
    run(currentTick: number): void {
        if (this._dirty) this._compact();

        this._running = true;
        const active = this._alloc.activeSlots;
        const count = this._alloc.size;
        for (let i = 0; i < count; i++) {
            const slot = active[i]!;
            const schedule = this._pool[slot]!;
            if (schedule.cancelled) continue;
            if (currentTick >= schedule.next) {
                if (schedule.repeat) {
                    schedule.next = currentTick + schedule.interval;
                } else {
                    schedule.cancelled = true;
                    this._dirty = true;
                }
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

        const active = this._alloc.activeSlots;
        const count = this._alloc.size;
        for (let i = 0; i < count; i++) {
            const schedule = this._pool[active[i]!]!;
            schedule.next = baseTick + schedule.interval;
        }
    }

    private _compact(): void {
        const alloc = this._alloc;
        let i = 0;
        while (i < alloc.size) {
            const slot = alloc.activeSlots[i]!;
            const schedule = this._pool[slot]!;
            if (schedule.cancelled) {
                schedule.cb = NOOP;
                schedule.cancelled = false;
                alloc.free(this._ids[slot]!);
                this._ids[slot] = -1;
            } else {
                i++;
            }
        }
        this._dirty = false;
    }
}

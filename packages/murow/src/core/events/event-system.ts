/* ---------- Types ---------- */
type Callback<Props> = (props: Props) => void;


type EventMapFromTuple<T extends [string, unknown][]> = {
    [K in T[number]as K[0]]: K[1];
};

/* ---------- Interfaces ---------- */
interface EventSystemProps<EventNames extends string> {
    /**
     * @description
     * The list of events to ever be registered.
     */
    events: EventNames[];
}

/**
 * Zero-allocation event system. Uses flat arrays instead of Map/Set
 * to avoid iterator allocations on every emit().
 */
export class EventSystem<EventTuple extends [string, unknown][]> {
    private eventIndex: Record<string, number>;
    private callbackArrays: (Callback<unknown> | null)[][];
    private callbackCounts: number[];
    private events: string[];
    private emitting: number = -1; // index of event currently being emitted, -1 if not emitting

    constructor({ events }: EventSystemProps<string>) {
        this.events = events;
        this.eventIndex = {};
        this.callbackArrays = new Array(this.events.length);
        this.callbackCounts = new Array(this.events.length).fill(0);

        for (let i = 0; i < this.events.length; i++) {
            this.eventIndex[this.events[i]] = i;
            this.callbackArrays[i] = [];
        }
    }

    /**
     * Registers a callback for an event.
     */
    on<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        callback: Callback<EventMapFromTuple<EventTuple>[EventName]>
    ): void {
        const idx = this.eventIndex[name];
        if (idx === undefined) return console.warn(`Event "${name}" does not exist.`);

        const arr = this.callbackArrays[idx];
        const count = this.callbackCounts[idx];

        // Deduplicate
        for (let i = 0; i < count; i++) {
            if (arr[i] === callback) return;
        }

        arr[count] = callback as Callback<unknown>;
        this.callbackCounts[idx]++;
    }

    /**
     * Registers a callback for an event that runs only once.
     */
    once<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        callback: Callback<EventMapFromTuple<EventTuple>[EventName]>
    ): void {
        const wrapper: Callback<EventMapFromTuple<EventTuple>[EventName]> = (props) => {
            callback(props);
            this.off(name, wrapper);
        };

        this.on(name, wrapper);
    }

    /**
     * Emits an event, running all registered callbacks.
     * Zero allocations — iterates a flat array with an index loop.
     * Safe to call off() during emit (nulled slots are skipped).
     */
    emit<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        data: EventMapFromTuple<EventTuple>[EventName]
    ) {
        const idx = this.eventIndex[name];
        if (idx === undefined) return console.warn(`Event "${name}" does not exist.`);

        const arr = this.callbackArrays[idx];
        const count = this.callbackCounts[idx];
        this.emitting = idx;

        for (let i = 0; i < count; i++) {
            const cb = arr[i];
            if (cb !== null) cb(data);
        }

        this.emitting = -1;

        // Compact nulled slots after emit
        this.compact(idx);
    }

    /**
     * Removes a callback from an event.
     * During emit: nulls the slot (compacted after emit finishes).
     * Outside emit: swap-and-pop for O(1).
     */
    off<EventName extends keyof EventMapFromTuple<EventTuple> & string>(
        name: EventName,
        callback: Callback<EventMapFromTuple<EventTuple>[EventName]>
    ): void {
        const idx = this.eventIndex[name];
        if (idx === undefined) return console.warn(`Event "${name}" does not exist.`);

        const arr = this.callbackArrays[idx];
        const count = this.callbackCounts[idx];
        for (let i = 0; i < count; i++) {
            if (arr[i] === callback) {
                if (this.emitting === idx) {
                    // During emit. just null the slot, compact later
                    arr[i] = null;
                } else {
                    // Outside emit. swap-and-pop
                    arr[i] = arr[count - 1];
                    arr[count - 1] = null;
                    this.callbackCounts[idx]--;
                }
                return;
            }
        }
    }

    /**
     * Removes all callbacks.
     */
    clear<EventName extends keyof EventMapFromTuple<EventTuple> & string>(name?: EventName): void {
        if (!name) {
            for (let i = 0; i < this.callbackArrays.length; i++) {
                this.callbackArrays[i].length = 0;
                this.callbackCounts[i] = 0;
            }
            return;
        }

        const idx = this.eventIndex[name];
        if (idx === undefined) return console.warn(`Event "${name}" does not exist.`);

        this.callbackArrays[idx].length = 0;
        this.callbackCounts[idx] = 0;
    }

    /**
     * Remove null gaps left by off() during emit.
     */
    private compact(idx: number): void {
        const arr = this.callbackArrays[idx];
        let write = 0;
        const count = this.callbackCounts[idx];

        for (let read = 0; read < count; read++) {
            if (arr[read] !== null) {
                arr[write++] = arr[read];
            }
        }

        // Clear trailing slots
        for (let i = write; i < count; i++) {
            arr[i] = null;
        }

        this.callbackCounts[idx] = write;
    }
}

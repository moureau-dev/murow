export interface TimelineEntry<S> {
    tick: number;
    receivedAt: number;
    sample: S;
}

/**
 * A bounded, tick-ordered ring of timestamped samples. Inserts in tick order
 * (dedup by tick), prunes to capacity, and drops history when a wall-clock gap
 * exceeds the stale window. Knows nothing about what a sample contains.
 */
export class Timeline<S> {
    private entries: TimelineEntry<S>[] = [];
    private _latestReceivedAt = -Infinity;
    capacity: number;
    staleWindow: number;
    /**
     * Called with a sample as it is dropped (capacity overflow, stale-window
     * reset, or `clear`). Lets the owner recycle the sample's storage.
     */
    onEvict: ((sample: S) => void) | null = null;

    constructor(capacity: number, staleWindowMs: number) {
        this.capacity = capacity;
        this.staleWindow = staleWindowMs;
    }

    get length(): number {
        return this.entries.length;
    }

    get latestReceivedAt(): number {
        return this._latestReceivedAt;
    }

    at(index: number): TimelineEntry<S> {
        return this.entries[index];
    }

    newest(): TimelineEntry<S> | undefined {
        return this.entries[this.entries.length - 1];
    }

    oldest(): TimelineEntry<S> | undefined {
        return this.entries[0];
    }

    setStaleWindow(staleWindowMs: number): void {
        this.staleWindow = staleWindowMs;
    }

    clear(): void {
        this.evictAll();
        this._latestReceivedAt = -Infinity;
    }

    /** Drop every entry, notifying `onEvict` for each. */
    private evictAll(): void {
        const onEvict = this.onEvict;
        if (onEvict !== null) {
            for (let i = 0; i < this.entries.length; i++) onEvict(this.entries[i]!.sample);
        }
        this.entries.length = 0;
    }

    /**
     * Insert a sample in tick order. Returns true if a wall-clock gap beyond
     * the stale window dropped the existing history first.
     */
    record(tick: number, receivedAt: number, sample: S): boolean {
        let reset = false;
        const gap = receivedAt - this._latestReceivedAt;
        if (this.entries.length > 0 && gap > this.staleWindow) {
            this.evictAll();
            this._latestReceivedAt = -Infinity;
            reset = true;
        }
        if (receivedAt > this._latestReceivedAt) {
            this._latestReceivedAt = receivedAt;
        }

        let insertAt = this.entries.length;
        while (insertAt > 0 && this.entries[insertAt - 1].tick >= tick) {
            if (this.entries[insertAt - 1].tick === tick) return reset;
            insertAt--;
        }
        this.entries.splice(insertAt, 0, { tick, receivedAt, sample });

        while (this.entries.length > this.capacity) {
            const evicted = this.entries.shift()!;
            this.onEvict?.(evicted.sample);
        }
        return reset;
    }

    /**
     * Indices `[a, b]` of the consecutive entries straddling `tick`
     * (`entries[a].tick <= tick <= entries[b].tick`), or null if none.
     */
    straddle(tick: number): [number, number] | null {
        for (let i = 0; i < this.entries.length - 1; i++) {
            if (this.entries[i].tick <= tick && tick <= this.entries[i + 1].tick) {
                return [i, i + 1];
            }
        }
        return null;
    }
}

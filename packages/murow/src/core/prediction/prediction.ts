/**
 * @template T
 * @description
 * Tracks client-side intents that have been sent to the server but not yet confirmed.
 * Used for prediction and reconciliation in a server-authoritative architecture.
 */
export class IntentTracker<T> {
  tracker = new Map<number, T[]>();

  get size() {
    return this.tracker.size;
  }

  /**
   * Adds a new intent for a specific tick.
   * @param {number} tick - The tick number associated with the intent.
   * @param {T} intent - The intent data.
   */
  track(tick: number, intent: T): T {
    if (!this.tracker.has(tick)) {
      this.tracker.set(tick, []);
    }

    this.tracker.get(tick).push(intent);
    return intent;
  }

  /**
   * Removes all intents up to and including a given tick.
   * Returns the remaining intents in ascending tick order.
   * @param {number} tick - The tick up to which intents should be dropped.
   * @returns {T[]} Array of remaining intents.
   */
  dropUpTo(tick: number): T[] {
    const remaining: [number, T[]][] = [];

    for (const [t, intents] of this.tracker) {
      if (t <= tick) this.tracker.delete(t);
      else remaining.push([t, intents]);
    }

    // sort by tick ascending
    remaining.sort(([a], [b]) => a - b);
    return remaining.map(([_, intents]) => intents).flat();
  }

  /**
   * Returns all currently tracked intents in ascending tick order.
   * @returns {T[]}
   */
  values(): T[] {
    return Array.from(this.tracker.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, intents]) => intents)
      .flat();
  }
}

/**
 * @template T,U
 * @description
 * Handles client-side reconciliation of authoritative snapshots with unconfirmed intents.
 * Used for prediction correction in server-authoritative multiplayer games.
 */
export class Reconciliator<T, U> {
  tracker: IntentTracker<T> = new IntentTracker<T>();

  /**
   * @param {Object} options - Callbacks for applying snapshot state and replaying intents.
   * @param {(snapshotState: U) => void} options.onLoadState - Called to load authoritative snapshot state.
   * @param {(remainingIntents: T[]) => void} options.onReplay - Called to reapply remaining intents for prediction.
   */
  constructor(
    private options: {
      onLoadState: (snapshotState: U) => void;
      onReplay: (remainingIntents: T[]) => void;
    }
  ) { }

  /**
   * Adds a new intent to the tracker.
   * @param {number} tick - Tick number associated with the intent.
   * @param {T} intent - The intent data.
   */
  trackIntent(tick: number, intent: T) {
    this.tracker.track(tick, intent);
  }

  /**
   * Called when an authoritative snapshot is received from the server.
   * Resets client state and replays unconfirmed intents.
   * @param {Object} snapshot - The snapshot from the server.
   * @param {number} snapshot.tick - Tick number of the snapshot.
   * @param {U} snapshot.state - The authoritative state.
   */
  onSnapshot(snapshot: { tick: number; state: U }) {
    // 1. Load authoritative state
    this.options.onLoadState(snapshot.state);

    // 2. Remove confirmed intents and get remaining
    const remainingIntents = this.tracker.dropUpTo(snapshot.tick);

    // 3. Only replay if there are actually remaining intents
    if (remainingIntents.length > 0) {
      this.options.onReplay(remainingIntents);
    }
  }

  replay(intents: T[]) {
    this.options.onReplay(intents);
  }
}

/**
 * @template T
 * @description
 * Tracks client-side intents that have been sent to the server but not yet confirmed.
 * Used for prediction and reconciliation in a server-authoritative architecture.
 */
export declare class IntentTracker<T> {
    tracker: Map<number, T[]>;
    get size(): number;
    /**
     * Adds a new intent for a specific tick.
     * @param {number} tick - The tick number associated with the intent.
     * @param {T} intent - The intent data.
     */
    track(tick: number, intent: T): T;
    /**
     * Removes all intents up to and including a given tick.
     * Returns the remaining intents in ascending tick order.
     * @param {number} tick - The tick up to which intents should be dropped.
     * @returns {T[]} Array of remaining intents.
     */
    dropUpTo(tick: number): T[];
    /**
     * Returns all currently tracked intents in ascending tick order.
     * @returns {T[]}
     */
    values(): T[];
}
/**
 * @template T,U
 * @description
 * Handles client-side reconciliation of authoritative snapshots with unconfirmed intents.
 * Used for prediction correction in server-authoritative multiplayer games.
 */
export declare class Reconciliator<T, U> {
    private options;
    tracker: IntentTracker<T>;
    /**
     * @param {Object} options - Callbacks for applying snapshot state and replaying intents.
     * @param {(snapshotState: U) => void} options.onLoadState - Called to load authoritative snapshot state.
     * @param {(remainingIntents: T[]) => void} options.onReplay - Called to reapply remaining intents for prediction.
     */
    constructor(options: {
        onLoadState: (snapshotState: U) => void;
        onReplay: (remainingIntents: T[]) => void;
    });
    /**
     * Adds a new intent to the tracker.
     * @param {number} tick - Tick number associated with the intent.
     * @param {T} intent - The intent data.
     */
    trackIntent(tick: number, intent: T): void;
    /**
     * Called when an authoritative snapshot is received from the server.
     * Resets client state and replays unconfirmed intents.
     * @param {Object} snapshot - The snapshot from the server.
     * @param {number} snapshot.tick - Tick number of the snapshot.
     * @param {U} snapshot.state - The authoritative state.
     */
    onSnapshot(snapshot: {
        tick: number;
        state: U;
    }): void;
    replay(intents: T[]): void;
}

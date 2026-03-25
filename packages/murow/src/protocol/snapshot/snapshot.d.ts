/**
 * Server-authoritative snapshot with delta updates.
 *
 * @template T The full state type
 */
export interface Snapshot<T> {
    /** Server tick when this snapshot was created */
    tick: number;
    /** Partial state updates (only what changed) */
    updates: Partial<T>;
}
/**
 * Apply snapshot updates to state (mutating).
 * Deep merges objects, replaces arrays.
 *
 * @param state State to update
 * @param snapshot Snapshot to apply
 */
export declare function applySnapshot<T>(state: T, snapshot: Snapshot<T>): void;

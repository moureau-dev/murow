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
export function applySnapshot<T>(state: T, snapshot: Snapshot<T>): void {
  deepMerge(state, snapshot.updates);
}

function deepMerge<T>(target: T, update: Partial<T>): void {
  for (const key in update) {
    if (!Object.prototype.hasOwnProperty.call(update, key)) continue;

    const updateValue = update[key];
    const targetValue = target[key];

    if (updateValue === null || updateValue === undefined) {
      target[key] = updateValue as T[Extract<keyof T, string>];
    } else if (Array.isArray(updateValue)) {
      target[key] = updateValue as T[Extract<keyof T, string>];
    } else if (typeof updateValue === "object" && typeof targetValue === "object") {
      deepMerge(targetValue as any, updateValue as any);
    } else {
      target[key] = updateValue as T[Extract<keyof T, string>];
    }
  }
}

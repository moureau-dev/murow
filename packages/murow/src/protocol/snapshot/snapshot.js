/**
 * Apply snapshot updates to state (mutating).
 * Deep merges objects, replaces arrays.
 *
 * @param state State to update
 * @param snapshot Snapshot to apply
 */
export function applySnapshot(state, snapshot) {
    deepMerge(state, snapshot.updates);
}
function deepMerge(target, update) {
    for (const key in update) {
        if (!Object.prototype.hasOwnProperty.call(update, key))
            continue;
        const updateValue = update[key];
        const targetValue = target[key];
        if (updateValue === null || updateValue === undefined) {
            target[key] = updateValue;
        }
        else if (Array.isArray(updateValue)) {
            target[key] = updateValue;
        }
        else if (typeof updateValue === "object" && typeof targetValue === "object") {
            deepMerge(targetValue, updateValue);
        }
        else {
            target[key] = updateValue;
        }
    }
}

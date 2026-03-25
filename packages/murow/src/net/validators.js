/**
 * Common intent validation helpers
 */
/**
 * Validate that intent tick is not in the past (with tolerance for network lag)
 *
 * NOTE: Pass the current tick value at the time you create the validator.
 * If your tick advances, you'll need to recreate the validator or use a function
 * that captures the current tick dynamically.
 *
 * @param currentTick Current server tick
 * @param tolerance Number of ticks to allow in the past (default: 10)
 *
 * @example
 * ```ts
 * // Option 1: Recreate validator each tick (simple but allocates)
 * function onTick(currentTick: number) {
 *   const validator = validateTickNotTooOld(currentTick);
 *   // use validator...
 * }
 *
 * // Option 2: Manual validation (zero allocation)
 * if (intent.tick >= currentTick - 10) {
 *   // intent is valid
 * }
 * ```
 */
export function validateTickNotTooOld(currentTick, tolerance = 10) {
    return (_peerId, intent) => {
        return intent.tick >= currentTick - tolerance;
    };
}
/**
 * Validate that intent tick is not too far in the future
 * @param currentTick Current server tick
 * @param tolerance Number of ticks to allow in the future (default: 5)
 */
export function validateTickNotTooFuture(currentTick, tolerance = 5) {
    return (_peerId, intent) => {
        return intent.tick <= currentTick + tolerance;
    };
}
/**
 * Validate intent tick is within acceptable range
 * @param currentTick Current server tick
 * @param pastTolerance Ticks allowed in past (default: 10)
 * @param futureTolerance Ticks allowed in future (default: 5)
 */
export function validateTickRange(currentTick, pastTolerance = 10, futureTolerance = 5) {
    return (_peerId, intent) => {
        return (intent.tick >= currentTick - pastTolerance &&
            intent.tick <= currentTick + futureTolerance);
    };
}
/**
 * Combine multiple validators with AND logic
 */
export function combineValidators(...validators) {
    return (peerId, intent) => {
        for (const validator of validators) {
            if (!validator(peerId, intent)) {
                return false;
            }
        }
        return true;
    };
}
/**
 * Validate that a numeric field is within a range
 */
export function validateRange(field, min, max) {
    return (_peerId, intent) => {
        const value = intent[field];
        if (typeof value !== "number") {
            return false;
        }
        return value >= min && value <= max;
    };
}
/**
 * Validate that a field exists and is of expected type
 */
export function validateFieldType(field, expectedType) {
    return (_peerId, intent) => {
        const value = intent[field];
        return typeof value === expectedType;
    };
}

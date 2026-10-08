/**
 * Base contract for a live handle. A handle is the ergonomic wrapper over one
 * pooled item: it carries the stable identity and forwards state to its manager.
 */
export interface HandleBase<Id extends number> {
    /** Stable, versioned identity. What `get(id)` takes. */
    readonly id: Id;
    /** False after destroy. Stale-handle operations are no-ops. */
    readonly alive: boolean;
    /** Idempotent. Returns the slot to the pool. */
    destroy(): void;
}

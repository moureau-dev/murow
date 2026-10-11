import type { CollectionItem } from 'murow/core/collection';

/**
 * A live handle over one collection item. The collection machinery (in
 * `murow/core/collection`) only requires `CollectionItem` (`id` + `destroy`);
 * renderer handles add the `alive` liveness flag on top.
 */
export interface HandleBase<Id extends number> extends CollectionItem<Id> {
    /** False after destroy. Stale-handle operations are no-ops. */
    readonly alive: boolean;
}

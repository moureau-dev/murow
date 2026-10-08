import type { EventSystem } from 'murow/core/events';
import type { HandleBase } from './handle-base';

/** Lifecycle events every collection emits. The payload is the affected handle. */
export type CollectionEventTuple<Handle> = [
    ['add', Handle],
    ['remove', Handle],
    ['clear', undefined],
];

/** The event system attached to every collection. */
export type CollectionEvents<Handle> = EventSystem<CollectionEventTuple<Handle>>;

/**
 * Read and lifecycle contract shared by every pooled manager. Creation is named
 * per manager (`add`, `create`) and therefore omitted here.
 */
export interface Collection<Id extends number, Handle extends HandleBase<Id>, Capacity = number> {
    /** Maximum live items. Fixed for the device lifetime. */
    readonly capacity: Capacity;
    /** Number of live items. */
    readonly count: number;
    /** The handle for `id`, or undefined when absent or stale. */
    get(id: Id): Handle | undefined;
    /** Whether `id` is currently live. */
    has(id: Id): boolean;
    /** Remove one item by id. Called by its handle. */
    remove(id: Id): void;
    /** Iterate live handles in dense slot order. Zero allocation. */
    each(cb: (handle: Handle) => void): void;
    /** Remove every live item, keeping the collection usable. */
    clear(): void;
    /** Release the collection's own resources. */
    destroy(): void;
    /** Lifecycle events: `add`, `remove`, `clear`. */
    readonly events: CollectionEvents<Handle>;
}

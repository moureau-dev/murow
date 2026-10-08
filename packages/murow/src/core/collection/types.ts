import type { EventSystem } from '../events';

/**
 * The minimal contract the collection machinery needs from a stored item: a
 * numeric identity and a way to release itself. Renderer handles extend this
 * (adding `alive`, typed setters, ...); the collection itself does not care.
 */
export interface CollectionItem<Id extends number> {
    /** Stable, versioned identity. What `get(id)` takes. */
    readonly id: Id;
    /** Release this item. Idempotent. */
    destroy(): void;
}

/** Lifecycle events every collection emits. The payload is the affected item. */
export type CollectionEventTuple<Item> = [
    ['add', Item],
    ['remove', Item],
    ['clear', undefined],
];

/** The event system attached to every collection. */
export type CollectionEvents<Item> = EventSystem<CollectionEventTuple<Item>>;

/**
 * Read and lifecycle contract shared by every pooled collection. Creation is
 * named per collection (`add`, `create`) and therefore omitted here.
 */
export interface Collection<Id extends number, Item extends CollectionItem<Id>, Capacity = number> {
    /** Maximum live items. Fixed for the device lifetime. */
    readonly capacity: Capacity;
    /** Number of live items. */
    readonly count: number;
    /** The item for `id`, or undefined when absent or stale. */
    get(id: Id): Item | undefined;
    /** Whether `id` is currently live. */
    has(id: Id): boolean;
    /** Remove one item by id. */
    remove(id: Id): void;
    /** Iterate live items in dense slot order. Zero allocation. */
    each(cb: (item: Item) => void): void;
    /** Remove every live item, keeping the collection usable. */
    clear(): void;
    /** Release the collection's own resources. */
    destroy(): void;
    /** Lifecycle events: `add`, `remove`, `clear`. */
    readonly events: CollectionEvents<Item>;
}

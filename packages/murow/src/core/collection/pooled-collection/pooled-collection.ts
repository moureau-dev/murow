import { EventSystem } from '../../events';
import { Logger } from '../../logger';
import { GenerationAllocator } from '../generation-allocator';
import type { Collection, CollectionItem, CollectionEventTuple, CollectionEvents } from '../types';

/** Options shared by every pooled collection. */
export interface PooledCollectionOptions<Capacity> {
    /** Number of slots the pool can hold. */
    readonly poolSize: number;
    /** Public capacity value: a number, or a small object for particles. */
    readonly capacity: Capacity;
    /** Logger used to report overflow. */
    readonly logger: Logger;
}

/**
 * Shared machinery for pooled collections: a generation-versioned slot space,
 * one item per slot, lifecycle events, and the shared read contract.
 *
 * Subclasses own their domain storage in parallel arrays indexed by slot, name
 * their own creation method, and implement `createItem`.
 */
export abstract class PooledCollection<
    Id extends number,
    Item extends CollectionItem<Id>,
    Capacity = number,
> implements Collection<Id, Item, Capacity> {
    protected readonly allocator: GenerationAllocator;
    protected readonly logger: Logger;
    readonly events: CollectionEvents<Item>;
    private readonly items: (Item | null)[];
    private readonly capacityValue: Capacity;

    protected constructor(options: PooledCollectionOptions<Capacity>) {
        this.allocator = new GenerationAllocator(options.poolSize);
        this.logger = options.logger;
        this.capacityValue = options.capacity;
        this.items = new Array<Item | null>(options.poolSize).fill(null);
        this.events = new EventSystem<CollectionEventTuple<Item>>({
            events: ['add', 'remove', 'clear'],
        });
    }

    get capacity(): Capacity {
        return this.capacityValue;
    }

    get count(): number {
        return this.allocator.size;
    }

    get(id: Id): Item | undefined {
        if (!this.allocator.isLive(id)) return undefined;
        return this.items[this.allocator.slotOf(id)] ?? undefined;
    }

    has(id: Id): boolean {
        return this.allocator.isLive(id);
    }

    remove(id: Id): void {
        this.releaseItem(id);
    }

    each(cb: (item: Item) => void): void {
        const active = this.allocator.activeSlots;
        const size = this.allocator.size;
        for (let i = 0; i < size; i++) cb(this.items[active[i]!]!);
    }

    clear(): void {
        const active = this.allocator.activeSlots;
        for (let i = this.allocator.size - 1; i >= 0; i--) {
            const slot = active[i]!;
            const item = this.items[slot];
            this.destroySlot(slot);
            this.items[slot] = null;
            if (item) this.events.emit('remove', item);
        }
        this.allocator.clear();
        this.events.emit('clear', undefined);
    }

    /**
     * Release every item and the collection's own resources. Subclasses with
     * collection-wide resources override this and call `super.destroy()`.
     */
    destroy(): void {
        this.clear();
    }

    /**
     * Allocate a slot, create and store its item, and emit `add`.
     * @returns the new id, slot and item, or `null` (after logging) when full.
     */
    protected allocateItem(): { id: Id; slot: number; item: Item } | null {
        const packed = this.allocator.allocate();
        if (packed === -1) {
            this.logger.error(`collection at capacity (${this.allocator.capacity}); add aborted`);
            return null;
        }
        const slot = this.allocator.slotOf(packed);
        const id = packed as Id;
        const item = this.createItem(id, slot);
        this.items[slot] = item;
        this.events.emit('add', item);
        return { id, slot, item };
    }

    /** Release one item and its slot, emitting `remove`. No-op if stale. */
    protected releaseItem(id: Id): void {
        if (!this.allocator.isLive(id)) return;
        const slot = this.allocator.slotOf(id);
        const item = this.items[slot];
        this.items[slot] = null;
        this.destroySlot(slot);
        this.allocator.free(id);
        if (item) this.events.emit('remove', item);
    }

    /** Create the item for a freshly allocated slot. */
    protected abstract createItem(id: Id, slot: number): Item;

    /**
     * Release the domain resources for one slot. Called on remove and clear.
     * Subclasses override this instead of the whole `clear`.
     */
    protected destroySlot(slot: number): void {}
}

import { EventSystem } from 'murow/core/events';
import { Logger } from 'murow/core/logger';
import { GenerationAllocator } from '../generation-allocator';
import type { HandleBase } from '../handle-base';
import type { Collection, CollectionEventTuple, CollectionEvents } from '../collection';

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
 * Shared machinery for pooled managers: a generation-versioned slot space, one
 * handle per slot, lifecycle events, and the shared read contract.
 *
 * Subclasses own their domain storage in parallel arrays indexed by slot, name
 * their own creation method, and implement `createHandle`.
 */
export abstract class PooledCollection<
    Id extends number,
    Handle extends HandleBase<Id>,
    Capacity = number,
> implements Collection<Id, Handle, Capacity> {
    protected readonly allocator: GenerationAllocator;
    protected readonly logger: Logger;
    readonly events: CollectionEvents<Handle>;
    private readonly handles: (Handle | null)[];
    private readonly capacityValue: Capacity;

    protected constructor(options: PooledCollectionOptions<Capacity>) {
        this.allocator = new GenerationAllocator(options.poolSize);
        this.logger = options.logger;
        this.capacityValue = options.capacity;
        this.handles = new Array<Handle | null>(options.poolSize).fill(null);
        this.events = new EventSystem<CollectionEventTuple<Handle>>({
            events: ['add', 'remove', 'clear'],
        });
    }

    get capacity(): Capacity {
        return this.capacityValue;
    }

    get count(): number {
        return this.allocator.size;
    }

    get(id: Id): Handle | undefined {
        if (!this.allocator.isLive(id)) return undefined;
        return this.handles[this.allocator.slotOf(id)] ?? undefined;
    }

    has(id: Id): boolean {
        return this.allocator.isLive(id);
    }

    remove(id: Id): void {
        this.releaseHandle(id);
    }

    each(cb: (handle: Handle) => void): void {
        const active = this.allocator.activeSlots;
        const size = this.allocator.size;
        for (let i = 0; i < size; i++) cb(this.handles[active[i]!]!);
    }

    clear(): void {
        const active = this.allocator.activeSlots;
        for (let i = this.allocator.size - 1; i >= 0; i--) {
            const slot = active[i]!;
            const handle = this.handles[slot];
            this.destroySlot(slot);
            this.handles[slot] = null;
            if (handle) this.events.emit('remove', handle);
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
     * Allocate a slot, create and store its handle, and emit `add`.
     * @returns the new id, slot and handle, or `null` (after logging) when full.
     */
    protected allocateHandle(): { id: Id; slot: number; handle: Handle } | null {
        const packed = this.allocator.alloc();
        if (packed === -1) {
            this.logger.error(`collection at capacity (${this.allocator.capacity}); add aborted`);
            return null;
        }
        const slot = this.allocator.slotOf(packed);
        const id = packed as Id;
        const handle = this.createHandle(id, slot);
        this.handles[slot] = handle;
        this.events.emit('add', handle);
        return { id, slot, handle };
    }

    /** Release one handle and its slot, emitting `remove`. No-op if stale. */
    protected releaseHandle(id: Id): void {
        if (!this.allocator.isLive(id)) return;
        const slot = this.allocator.slotOf(id);
        const handle = this.handles[slot];
        this.handles[slot] = null;
        this.destroySlot(slot);
        this.allocator.free(id);
        if (handle) this.events.emit('remove', handle);
    }

    /** Create the handle for a freshly allocated slot. */
    protected abstract createHandle(id: Id, slot: number): Handle;

    /**
     * Release the domain resources for one slot. Called on remove and clear.
     * Subclasses override this instead of the whole `clear`.
     */
    protected destroySlot(slot: number): void {}
}

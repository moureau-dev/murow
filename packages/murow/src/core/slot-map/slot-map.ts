/**
 * SlotMap / SlotStore — dense, recyclable slot sets with O(1) add/remove/lookup.
 *
 * SlotMap manages integer slots: a FreeList for allocation, a dense packed
 * array for zero-allocation iteration, and a sparse reverse index for O(1)
 * lookup. The id IS the slot — one number, stable for the slot's lifetime,
 * safe to use as a GPU buffer index or store inside a handle.
 *
 * SlotStore<TId, T> layers an object array on top of SlotMap, keyed by an
 * external id that need not equal the slot. It is the typed replacement for
 * `Map<id, handle>` collections that are iterated every frame.
 */
import { FreeList } from '../free-list';

/**
 * A branded integer id. Use `as SlotId<'light'>` (or your own brand) to keep
 * a light id from being passed where an instance id is expected. Purely a
 * compile-time tag — at runtime it is a plain number.
 */
export type SlotId<Brand extends string = string> = number & { readonly __slot?: Brand };

/**
 * Dense membership set for externally chosen integer ids in `[0, capacity)`.
 *
 * Keeps live ids packed in `dense` for zero-allocation iteration, with a
 * sparse id -> dense index (`-1` when absent) and a per-id flag for O(1)
 * membership. It does NOT allocate ids; the caller owns id allocation.
 */
export class SlotSet {
    private readonly dense: Uint32Array;
    private readonly sparse: Int32Array;
    private readonly flags: Uint8Array;
    private _size = 0;

    constructor(private readonly _capacity: number) {
        this.dense = new Uint32Array(_capacity);
        this.sparse = new Int32Array(_capacity).fill(-1);
        this.flags = new Uint8Array(_capacity);
    }

    /** Add `id`. Returns false if out of range or already present. */
    add(id: number): boolean {
        if (id < 0 || id >= this._capacity || this.flags[id] === 1) return false;
        this.flags[id] = 1;
        this.sparse[id] = this._size;
        this.dense[this._size++] = id;
        return true;
    }

    /**
     * Remove `id`, keeping `dense` packed by swapping the last live id into the
     * freed position. Returns false if out of range or already absent.
     */
    remove(id: number): boolean {
        if (id < 0 || id >= this._capacity) return false;
        const idx = this.sparse[id]!;
        if (idx === -1) return false;

        const last = this._size - 1;
        if (idx !== last) {
            const lastId = this.dense[last]!;
            this.dense[idx] = lastId;
            this.sparse[lastId] = idx;
        }
        this.sparse[id] = -1;
        this.flags[id] = 0;
        this._size--;
        return true;
    }

    /** Whether `id` is currently live. O(1). */
    has(id: number): boolean {
        return id >= 0 && id < this._capacity && this.flags[id] === 1;
    }

    /** Packed live ids, valid for `[0, size)`. Reused across calls. */
    get denseBuffer(): Uint32Array {
        return this.dense;
    }

    /** Number of live ids. */
    get size(): number {
        return this._size;
    }

    /** Configured capacity. */
    get capacity(): number {
        return this._capacity;
    }

    /** Empty the set. */
    clear(): void {
        for (let i = 0; i < this._size; i++) {
            const id = this.dense[i]!;
            this.sparse[id] = -1;
            this.flags[id] = 0;
        }
        this._size = 0;
    }
}

/**
 * Dense slot set. Slots are allocated from a fixed-capacity FreeList; the id
 * returned by `add` IS the slot and stays stable until freed. Live slots are
 * kept in a packed array (`activeSlots`, via the underlying `SlotSet`) for
 * cache-friendly iteration with no per-call allocation.
 */
export class SlotMap {
    private readonly freeList: FreeList;
    private readonly set: SlotSet;
    private readonly _capacity: number;

    constructor(capacity: number) {
        this._capacity = capacity;
        this.freeList = new FreeList(capacity);
        this.set = new SlotSet(capacity);
    }

    /**
     * Allocate a slot and add it to the live set.
     * @returns the slot, or `-1` if the pool is exhausted.
     */
    add(): number {
        const slot = this.freeList.allocate();
        if (slot === -1) return -1;
        this.set.add(slot);
        return slot;
    }

    /**
     * Remove a slot from the live set and return it to the pool. No-op if the
     * slot is not live.
     */
    remove(slot: number): void {
        if (!this.set.remove(slot)) return;
        this.freeList.free(slot);
    }

    /** Whether `slot` is currently live. O(1). */
    has(slot: number): boolean {
        return this.set.has(slot);
    }

    /**
     * The packed live-slot array. Valid for indices `[0, size)`; entries past
     * `size` are stale. Reused across calls — do not retain.
     */
    get activeSlots(): Uint32Array {
        return this.set.denseBuffer;
    }

    /** Number of live slots. Iterate `activeSlots` over `[0, size)`. */
    get size(): number {
        return this.set.size;
    }

    /** Configured capacity (max simultaneously live slots). */
    get capacity(): number {
        return this._capacity;
    }

    /** Whether another slot can be allocated. */
    hasAvailable(): boolean {
        return this.freeList.hasAvailable();
    }

    /**
     * Iterate live slots in packed order. Zero allocations. Removing the
     * current slot inside the callback is safe (swap-and-pop), but the
     * swapped-in slot then occupies the current index — guard accordingly or
     * iterate `activeSlots` manually if you need full control.
     */
    forEach(fn: (slot: number, index: number) => void): void {
        const dense = this.set.denseBuffer;
        const size = this.set.size;
        for (let i = 0; i < size; i++) fn(dense[i]!, i);
    }

    /** Empty the set, returning every slot to the pool. */
    clear(): void {
        const dense = this.set.denseBuffer;
        const size = this.set.size;
        for (let i = 0; i < size; i++) this.freeList.free(dense[i]!);
        this.set.clear();
    }
}

/**
 * Dense object set keyed by an external id. Wraps a SlotMap (slot lifecycle +
 * dense iteration) and a slot-indexed object array, plus a sparse id -> slot
 * map so the external id need not equal the slot. The typed, tested
 * replacement for `Map<id, T>` collections you iterate every frame.
 *
 * `capacity` caps how many items can be live at once. `maxId` sizes the id
 * lookup table and defaults to `capacity`; pass it when ids come from a larger
 * space than the store holds (e.g. a 256-slot archetype store keyed by ECS
 * entity ids drawn from `maxEntities`). Ids must be non-negative integers
 * below `maxId`. If your identity is a string or otherwise non-integer, keep a
 * `Map<string, number>` at the boundary that translates it to a dense id once.
 */
export class SlotStore<TId extends number, T> {
    private readonly slots: SlotMap;
    /** slot -> stored item. */
    private readonly items: (T | null)[];
    /** external id -> slot, or `-1` if the id is not present. Sized by maxId. */
    private readonly idToSlot: Int32Array;
    /** slot -> external id (so dense iteration can report the id). */
    private readonly slotToId: Int32Array;
    private readonly _maxId: number;

    constructor(capacity: number, maxId: number = capacity) {
        this.slots = new SlotMap(capacity);
        this.items = new Array<T | null>(capacity).fill(null);
        this.idToSlot = new Int32Array(maxId).fill(-1);
        this.slotToId = new Int32Array(capacity).fill(-1);
        this._maxId = maxId;
    }

    /**
     * Store `item` under `id`. Allocates a slot. Throws if `id` is already
     * present or the pool is exhausted.
     * @returns the allocated slot.
     */
    add(id: TId, item: T): number {
        if (id < 0 || id >= this._maxId) {
            throw new Error(`SlotStore: id ${id} out of range [0, ${this._maxId})`);
        }
        if (this.idToSlot[id] !== -1) {
            throw new Error(`SlotStore: id ${id} is already present`);
        }
        const slot = this.slots.add();
        if (slot === -1) {
            throw new Error(`SlotStore: capacity (${this.slots.capacity}) reached`);
        }
        this.items[slot] = item;
        this.idToSlot[id] = slot;
        this.slotToId[slot] = id;
        return slot;
    }

    /** Remove the item stored under `id`. No-op if absent or out of range. */
    remove(id: TId): void {
        if (id < 0 || id >= this._maxId) return;
        const slot = this.idToSlot[id];
        if (slot === -1) return;
        this.items[slot] = null;
        this.idToSlot[id] = -1;
        this.slotToId[slot] = -1;
        this.slots.remove(slot);
    }

    /** The item stored under `id`, or `null` if absent or out of range. O(1). */
    get(id: TId): T | null {
        if (id < 0 || id >= this._maxId) return null;
        const slot = this.idToSlot[id];
        return slot === -1 ? null : this.items[slot]!;
    }

    /** Whether `id` is present. O(1). */
    has(id: TId): boolean {
        return id >= 0 && id < this._maxId && this.idToSlot[id] !== -1;
    }

    /** The stable slot for `id`, or `-1` if absent or out of range. */
    slotOf(id: TId): number {
        if (id < 0 || id >= this._maxId) return -1;
        return this.idToSlot[id]!;
    }

    /** Number of stored items. */
    get size(): number {
        return this.slots.size;
    }

    /** Configured capacity. */
    get capacity(): number {
        return this.slots.capacity;
    }

    /** Whether another item can be added. */
    hasAvailable(): boolean {
        return this.slots.hasAvailable();
    }

    /**
     * Iterate stored items in packed order. Zero allocations. The callback
     * receives the item, its external id, and its slot.
     */
    forEach(fn: (item: T, id: TId, slot: number) => void): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            fn(this.items[slot]!, this.slotToId[slot] as TId, slot);
        }
    }

    /** Remove every item. */
    clear(): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            const id = this.slotToId[slot];
            this.items[slot] = null;
            if (id !== -1) this.idToSlot[id] = -1;
            this.slotToId[slot] = -1;
        }
        this.slots.clear();
    }
}

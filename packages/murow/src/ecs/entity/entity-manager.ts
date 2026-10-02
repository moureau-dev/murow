import { SlotSet } from '../../core/slot-map';

/**
 * Entity ID type (just a number, indexing into component arrays)
 */
export type Entity = Uint32Array[number];

/**
 * Owns entity lifecycle storage: the free-id ring buffer for O(1) id reuse
 * and a dense alive set backed by the core `SlotSet` (packed dense array +
 * sparse index + per-id flags for O(1) alive checks and swap-pop removal).
 *
 * Component clearing, query maintenance, and despawn tracking are orchestrated
 * by `World` around `spawn`/`despawn`; this class only manages id allocation
 * and alive membership.
 */
export class EntityManager {
    private nextEntityId: number = 0;

    private freeEntityIds: Uint32Array;
    private freeEntityHead: number = 0;
    private freeEntityTail: number = 0;
    private freeEntityCount: number = 0;
    private freeEntityMask: number = 0;

    private readonly alive: SlotSet;

    constructor(private readonly maxEntities: number) {
        const ringBufferSize = Math.pow(2, Math.ceil(Math.log2(maxEntities)));
        this.freeEntityIds = new Uint32Array(ringBufferSize);
        this.freeEntityMask = ringBufferSize - 1;

        this.alive = new SlotSet(maxEntities);
    }

    spawn(): Entity {
        let id = this.nextEntityId;

        if (this.freeEntityCount > 0) {
            id = this.freeEntityIds[this.freeEntityTail]!;
            this.freeEntityTail = (this.freeEntityTail + 1) & this.freeEntityMask;
            this.freeEntityCount--;
        } else {
            this.nextEntityId++;
        }

        if (id >= this.maxEntities) {
            throw new Error(
                `Maximum entities (${this.maxEntities}) reached. ` +
                    `Current alive: ${this.alive.size}, ` +
                    `Free list: ${this.freeEntityCount}`,
            );
        }

        this.alive.add(id);
        return id;
    }

    /**
     * Remove the entity from the alive set and return its id to the free ring.
     * Returns false if the entity was already despawned, so callers can skip
     * the rest of the despawn sequence.
     */
    despawn(entity: Entity): boolean {
        if (!this.alive.remove(entity)) return false;

        this.freeEntityIds[this.freeEntityHead] = entity;
        this.freeEntityHead = (this.freeEntityHead + 1) & this.freeEntityMask;
        this.freeEntityCount++;

        return true;
    }

    isAlive(entity: Entity): boolean {
        return this.alive.has(entity);
    }

    get count(): number {
        return this.alive.size;
    }

    getMaxEntities(): number {
        return this.maxEntities;
    }

    getEntities(): Uint32Array {
        return this.alive.denseBuffer.subarray(0, this.alive.size);
    }

    /** Full-capacity dense alive buffer; valid entries are in [0, count). */
    get aliveBuffer(): Uint32Array {
        return this.alive.denseBuffer;
    }
}

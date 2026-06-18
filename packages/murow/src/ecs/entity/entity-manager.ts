/**
 * Entity ID type (just a number, indexing into component arrays)
 */
export type Entity = Uint32Array[number];

/**
 * Owns entity lifecycle storage: the free-id ring buffer for O(1) id reuse
 * and a dense alive list (packed in [0, count)) backed by a sparse index and
 * per-entity flags for O(1) alive checks and swap-pop removal.
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

    private aliveEntitiesArray: Uint32Array;
    private aliveCount: number = 0;
    private aliveEntitiesIndices: Uint32Array;
    private aliveEntityFlags: Uint8Array;

    constructor(private readonly maxEntities: number) {
        const ringBufferSize = Math.pow(2, Math.ceil(Math.log2(maxEntities)));
        this.freeEntityIds = new Uint32Array(ringBufferSize);
        this.freeEntityMask = ringBufferSize - 1;

        this.aliveEntitiesArray = new Uint32Array(maxEntities);
        this.aliveEntitiesIndices = new Uint32Array(maxEntities);
        this.aliveEntityFlags = new Uint8Array(maxEntities);
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
                    `Current alive: ${this.aliveCount}, ` +
                    `Free list: ${this.freeEntityCount}`,
            );
        }

        this.aliveEntityFlags[id] = 1;
        this.aliveEntitiesIndices[id] = this.aliveCount;
        this.aliveEntitiesArray[this.aliveCount++] = id;

        return id;
    }

    /**
     * Remove the entity from the alive set (swap-pop) and return its id to the
     * free list. Returns false if the entity was already despawned, so callers
     * can skip the rest of the despawn sequence.
     */
    despawn(entity: Entity): boolean {
        if (this.aliveEntityFlags[entity] === 0) return false;
        this.aliveEntityFlags[entity] = 0;

        const idx = this.aliveEntitiesIndices[entity]!;
        const last = this.aliveCount - 1;
        if (idx !== last) {
            const lastEntity = this.aliveEntitiesArray[last]!;
            this.aliveEntitiesArray[idx] = lastEntity;
            this.aliveEntitiesIndices[lastEntity] = idx;
        }
        this.aliveCount--;

        this.freeEntityIds[this.freeEntityHead] = entity;
        this.freeEntityHead = (this.freeEntityHead + 1) & this.freeEntityMask;
        this.freeEntityCount++;

        return true;
    }

    isAlive(entity: Entity): boolean {
        return this.aliveEntityFlags[entity] === 1;
    }

    get count(): number {
        return this.aliveCount;
    }

    getMaxEntities(): number {
        return this.maxEntities;
    }

    getEntities(): Uint32Array {
        return this.aliveEntitiesArray.subarray(0, this.aliveCount);
    }

    /** Full-capacity dense alive buffer; valid entries are in [0, count). */
    get aliveBuffer(): Uint32Array {
        return this.aliveEntitiesArray;
    }
}

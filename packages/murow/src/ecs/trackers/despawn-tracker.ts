import type { Entity } from "../entity/entity-manager";

/**
 * Per-tick log of entities despawned since the last flush. An append-only
 * Uint32Array, not a membership set: `record` appends, `getDespawned` returns
 * a zero-allocation view, `flush` resets the count. Higher-level packages read
 * this to propagate removals to peers.
 */
export class DespawnTracker {
    private buffer: Uint32Array;
    private count: number = 0;

    constructor(maxEntities: number) {
        this.buffer = new Uint32Array(maxEntities);
    }

    record(entity: Entity): void {
        this.buffer[this.count++] = entity;
    }

    getDespawned(): Uint32Array {
        return this.buffer.subarray(0, this.count);
    }

    flush(): void {
        this.count = 0;
    }
}

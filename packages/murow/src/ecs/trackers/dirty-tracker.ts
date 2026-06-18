import type { Entity } from "../entity/entity-manager";

/**
 * Per-component dirty bitmask, indexed by [componentIndex][entity>>>5].
 * `null` for components without `__sync` metadata: no overhead when networking
 * isn't in play. Higher-level packages read these to build per-peer snapshot
 * deltas. Component-index resolution is done by `World` before delegating here.
 */
export class DirtyTracker {
    private bitsByComponent: (Uint32Array | null)[] = [];

    constructor(private readonly maxEntities: number) {}

    /** Allocate (synced) or skip (unsynced) a component's dirty bitmap. */
    register(componentIndex: number, synced: boolean): void {
        this.bitsByComponent[componentIndex] = synced
            ? new Uint32Array(Math.ceil(this.maxEntities / 32))
            : null;
    }

    markDirty(entity: Entity, componentIndex: number): void {
        const bits = this.bitsByComponent[componentIndex];
        if (bits === null || bits === undefined) return;
        bits[entity >>> 5] |= 1 << (entity & 31);
    }

    isDirty(entity: Entity, componentIndex: number): boolean {
        const bits = this.bitsByComponent[componentIndex];
        if (bits === null || bits === undefined) return false;
        return (bits[entity >>> 5]! & (1 << (entity & 31))) !== 0;
    }

    clearDirty(entity: Entity, componentIndex: number): void {
        const bits = this.bitsByComponent[componentIndex];
        if (bits === null || bits === undefined) return;
        bits[entity >>> 5] &= ~(1 << (entity & 31));
    }

    forEachDirty(componentIndex: number, cb: (entity: Entity) => void): void {
        const bits = this.bitsByComponent[componentIndex];
        if (bits === null || bits === undefined) return;
        for (let w = 0; w < bits.length; w++) {
            let word = bits[w]!;
            if (word === 0) continue;
            const base = w << 5;
            while (word !== 0) {
                const bit = word & -word;
                const lsb = 31 - Math.clz32(bit);
                cb(base + lsb);
                word ^= bit;
            }
        }
    }

    clearAll(): void {
        for (let i = 0; i < this.bitsByComponent.length; i++) {
            const bits = this.bitsByComponent[i];
            if (bits !== null && bits !== undefined) bits.fill(0);
        }
    }
}

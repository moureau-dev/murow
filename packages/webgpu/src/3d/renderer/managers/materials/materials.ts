import type { AnyWgslData } from 'typegpu/data';
import { PooledCollection } from '../../collection/pooled-collection';
import type { MaterialId } from '../../collection/ids';
import type { Logger } from 'murow/core';
import type { MaterialLibrary, MaterialHandle } from './material-library';
import type { MaterialSpec } from './specs';

/** Dependencies of `MaterialManager`: the raw registry plus a logger. */
export interface MaterialManagerDeps {
    capacity: number;
    logger: Logger;
    library: MaterialLibrary;
    /** Reassign every instance using a 1-based material id to the default. */
    reassignUsers?(materialId: number): void;
}

/**
 * MaterialManager is the public facade over `MaterialLibrary`. It owns the
 * versioned material identity space; the library owns the compiled pipelines,
 * uniform buffers and bind groups.
 */
export class MaterialManager extends PooledCollection<MaterialId, MaterialHandle<any>, number> {
    /** The raw registry behind this facade, read by the renderer's pass sequencing. */
    readonly library: MaterialLibrary;
    private readonly deps: MaterialManagerDeps;
    private readonly origDestroy: (((...args: never[]) => void) | null)[];
    private pendingSpec: MaterialSpec | null = null;

    constructor(deps: MaterialManagerDeps) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger });
        this.deps = deps;
        this.library = deps.library;
        this.origDestroy = new Array(deps.capacity).fill(null);
    }

    /**
     * Compile a material from a declarative spec.
     * @returns the material handle, or `null` when the pool is full.
     */
    create<U extends Record<string, AnyWgslData> = {}>(spec: MaterialSpec & { uniforms?: U }): MaterialHandle<U> | null {
        this.pendingSpec = spec;
        const allocated = this.allocateHandle();
        this.pendingSpec = null;
        return (allocated ? allocated.handle : null) as unknown as MaterialHandle<U> | null;
    }

    protected destroySlot(slot: number): void {
        this.origDestroy[slot]?.();
        this.origDestroy[slot] = null;
    }

    protected createHandle(id: MaterialId, slot: number): MaterialHandle<any> {
        const raw = this.library.createMaterial(this.pendingSpec!, id);
        const orig = raw.destroy.bind(raw);
        this.origDestroy[slot] = orig;
        Object.defineProperty(raw, 'alive', { configurable: true, get: () => this.has(id) });
        raw.destroy = (opts?: { force?: boolean }) => this.destroyMaterial(id, opts);
        return raw;
    }

    /**
     * Destroy a material, honouring its live-instance refcount. Without force
     * this throws while instances still use it; with force the users are
     * reassigned to the default material first. Idempotent.
     */
    private destroyMaterial(id: MaterialId, opts?: { force?: boolean }): void {
        if (!this.allocator.isLive(id)) return;
        const materialId = this.allocator.slotOf(id) + 1;
        const uses = this.library.useCount(materialId);
        if (uses > 0) {
            if (!opts?.force) {
                throw new Error(
                    `Cannot destroy material: ${uses} instance(s) still use it. ` +
                    `Pass { force: true } to reassign them to the default material.`,
                );
            }
            this.deps.reassignUsers?.(materialId);
        }
        this.remove(id);
    }

}

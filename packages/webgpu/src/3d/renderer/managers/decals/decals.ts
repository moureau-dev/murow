import { PooledCollection } from '../../collection/pooled-collection';
import type { DecalId, LayerId } from '../../collection/ids';
import type { Logger } from 'murow/core';
import type { MaterialHandle } from '../materials/material-library';
import type { MaterialSpec } from '../materials/specs';
import { DecalLayer, type DecalInstance, type DecalLayerOptions, type SpawnDecalOptions } from './decal-layer';
import type { Handles } from '../../handles';

type ManagedDecalLayer = Handles.DecalLayer;
type DecalHandle = Handles.DecalHandle;

/** Dependencies of `DecalManager`. */
export interface DecalManagerDeps {
    capacity: number;
    logger: Logger;
    createMaterial(spec: MaterialSpec): MaterialHandle;
    addDecalInstance(prefab: string, material: MaterialHandle): DecalInstance;
    elapsedSeconds(): number;
}

/**
 * DecalManager owns decal layers. Each layer holds its own pooled marks and
 * atlas material; `add` on a layer returns an addressable `DecalHandle`.
 */
export class DecalManager extends PooledCollection<LayerId, ManagedDecalLayer, number> {
    private readonly deps: DecalManagerDeps;
    private readonly inner: (DecalLayer | null)[];
    private pendingOptions: DecalLayerOptions | null = null;

    constructor(deps: DecalManagerDeps) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger });
        this.deps = deps;
        this.inner = new Array(deps.capacity).fill(null);
    }

    /**
     * Create a pooled decal layer (blood / scorch / AoE marks).
     * @returns the layer, or `null` when the pool is full.
     */
    createLayer(spec: DecalLayerOptions): ManagedDecalLayer | null {
        this.pendingOptions = spec;
        const allocated = this.allocateHandle();
        this.pendingOptions = null;
        return allocated ? allocated.handle : null;
    }

    protected createHandle(id: LayerId, slot: number): ManagedDecalLayer {
        const layer = new DecalLayer({
            createMaterial: (spec) => this.deps.createMaterial(spec),
            addDecalInstance: (prefab, material) => this.deps.addDecalInstance(prefab, material),
            elapsedSeconds: () => this.deps.elapsedSeconds(),
        }, this.pendingOptions!);
        this.inner[slot] = layer;
        return new ManagedDecalLayerImpl(id, layer, () => this.remove(id));
    }

    protected releaseHandle(id: LayerId): void {
        if (!this.allocator.isLive(id)) return;
        const slot = this.allocator.slotOf(id);
        this.inner[slot] = null;
        super.releaseHandle(id);
    }
}

/** A decal layer handle that exposes addressable per-decal handles. */
class ManagedDecalLayerImpl implements ManagedDecalLayer {
    readonly id: LayerId;
    private readonly layer: DecalLayer;
    private readonly onDestroy: () => void;
    private destroyed = false;

    constructor(id: LayerId, layer: DecalLayer, onDestroy: () => void) {
        this.id = id;
        this.layer = layer;
        this.onDestroy = onDestroy;
    }

    get capacity(): number { return this.layer.capacity; }
    get count(): number { return this.layer.count; }
    get alive(): boolean { return !this.destroyed; }

    add(x: number, y: number, z: number, nx: number, ny: number, nz: number, opts?: unknown): DecalHandle | null {
        if (this.destroyed) return null;
        const slot = this.layer.spawn(x, y, z, nx, ny, nz, (opts ?? {}) as SpawnDecalOptions);
        const version = this.layer.versionOf(slot);
        return new ManagedDecalHandle(slot as DecalId, x, y, z, () => this.layer.remove(slot, version));
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.layer.destroy();
        this.onDestroy();
    }
}

/** A single decal. Decals expire by lifetime; `destroy` removes it early. */
class ManagedDecalHandle implements DecalHandle {
    readonly id: DecalId;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    private readonly remove: () => void;
    private _alive = true;

    constructor(id: DecalId, x: number, y: number, z: number, remove: () => void) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.z = z;
        this.remove = remove;
    }

    get alive(): boolean { return this._alive; }

    destroy(): void {
        if (!this._alive) return;
        this._alive = false;
        this.remove();
    }
}

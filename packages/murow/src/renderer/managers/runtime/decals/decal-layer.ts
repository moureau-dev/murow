import { RingStore } from 'murow/core/ring';
import type { MaterialHandle } from '../materials';
import type { MaterialSpec } from '../materials/specs';
import { decalMaterialSpec } from './decal-material';
import { decalEuler } from './orientation';

/** The renderer surface the layer needs (keeps this module decoupled). */
export interface DecalLayerHost {
    createMaterial(spec: MaterialSpec): MaterialHandle;
    /** Spawn a hidden instance to be reused for a decal slot. */
    addDecalInstance(prefab: string, material: MaterialHandle): DecalInstance;
    /** Renderer elapsed time in seconds (matches `scene.time`). */
    elapsedSeconds(): number;
}

/** The subset of `MeshInstanceHandle` the layer uses. */
export interface DecalInstance {
    /** Set position without interpolation (decals must not slide into place). */
    teleport?(x: number, y: number, z: number): void;
    setPosition(x: number, y: number, z: number): void;
    setRotation(x: number, y: number, z: number): void;
    setScale(x: number, y: number, z: number): void;
    setMaterialParams?(a: number, b: number): void;
    /** Free the backing instance when a decal is removed. */
    destroy?(): void;
}

export interface DecalLayerOptions {
    /** Atlas texture id from the AssetBucket. */
    atlas: string;
    /** Quad prefab id (default `'decalQuad'`). */
    quad?: string;
    /** Pool size; the oldest decal is recycled past this. */
    capacity?: number;
    /** Atlas grid columns / rows. Default 4. */
    cols?: number;
    rows?: number;
    /** Seconds to fade out. Default 8. */
    life?: number;
}

export interface SpawnDecalOptions {
    /** Atlas cell index. Default 0. */
    cell?: number;
    /** World size. Default 1. */
    size?: number;
    /** In-plane spin (radians). Defaults to a golden-angle step for variety. */
    roll?: number;
}

interface DecalSlot {
    instance: DecalInstance | null;
    /** Bumped on every spawn so a stale handle cannot remove a recycled slot. */
    version: number;
}

/**
 * A pool of decal instances. `spawn` writes into the next slot (recycling the
 * oldest past capacity); the fade is computed in the shader from the spawn
 * time, so the CPU never needs to expire anything.
 */
export class DecalLayer {
    readonly material: MaterialHandle;
    private readonly host: DecalLayerHost;
    private readonly quad: string;
    private readonly ring: RingStore<DecalSlot>;
    private rollCursor = 0;

    constructor(host: DecalLayerHost, opts: DecalLayerOptions) {
        this.host = host;
        this.quad = opts.quad ?? 'decalQuad';
        this.material = host.createMaterial(decalMaterialSpec({
            atlas: opts.atlas,
            cols: opts.cols ?? 4,
            rows: opts.rows ?? 4,
            life: opts.life,
        }));
        // Slots start empty; the instance is registered on first use so
        // unspawned decals never enter the batcher.
        this.ring = new RingStore<DecalSlot>({
            capacity: opts.capacity ?? 256,
            create: () => ({ instance: null, version: 0 }),
        });
    }

    get capacity(): number { return this.ring.capacity; }
    /** Number of decals spawned so far (saturates at capacity). */
    get count(): number { return this.ring.size; }

    /**
     * Place a decal on a surface. `(nx,ny,nz)` is the surface normal.
     * Returns the physical pool slot.
     */
    spawn(x: number, y: number, z: number, nx: number, ny: number, nz: number, opts: SpawnDecalOptions = {}): number {
        const slot = this.ring.push();
        const rec = this.ring.get(slot);
        rec.version++;
        let instance = rec.instance;
        if (instance === null) {
            instance = this.host.addDecalInstance(this.quad, this.material);
            rec.instance = instance;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        const ux = nx / len, uy = ny / len, uz = nz / len;
        const roll = opts.roll ?? (this.rollCursor += 2.399963229728653);
        const e = decalEuler(ux, uy, uz, roll);
        const off = 0.01;
        if (instance.teleport) instance.teleport(x + ux * off, y + uy * off, z + uz * off);
        else instance.setPosition(x + ux * off, y + uy * off, z + uz * off);
        instance.setRotation(e[0], e[1], e[2]);
        instance.setScale(opts.size ?? 1, opts.size ?? 1, opts.size ?? 1);
        instance.setMaterialParams?.(opts.cell ?? 0, this.host.elapsedSeconds());
        return slot;
    }

    /** Version of the decal currently occupying `slot`. */
    versionOf(slot: number): number {
        return this.ring.get(slot).version;
    }

    /**
     * Remove the decal at `slot`, freeing its backing instance. No-op when the
     * version does not match, so a stale handle cannot remove a recycled decal.
     */
    remove(slot: number, version: number): void {
        const rec = this.ring.get(slot);
        if (rec.version !== version) return;
        rec.version++;
        if (rec.instance) {
            rec.instance.destroy?.();
            rec.instance = null;
        }
    }

    /** Release this layer's compiled material and free every decal. */
    destroy(): void {
        this.ring.forEach((rec) => {
            rec.instance?.destroy?.();
            rec.instance = null;
        });
        this.material.destroy({ force: true });
    }
}

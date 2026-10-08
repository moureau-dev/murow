import { PooledCollection } from '../../collection/pooled-collection';
import type { Interpolator } from '../../types';
import type { LightId } from '../../collection/ids';
import type { Logger } from 'murow/core';
import type { Handles } from '../../handles';
import type { LightSpec } from './light-system';
import { LightSystem } from './light-system';

type LightHandle = Handles.LightHandle;

/** Dependencies of `LightManager`. */
export interface LightManagerDeps {
    capacity: number;
    logger: Logger;
    system: LightSystem;
}

/**
 * LightManager is the public facade over `LightSystem`. It owns the versioned
 * light identity space and the scene-level directional/ambient terms.
 */
export class LightManager extends PooledCollection<LightId, LightHandle, number> implements Interpolator {
    /** The CPU light system, read by the renderer's pass sequencing. */
    readonly system: LightSystem;
    private readonly origDestroy: (((...args: never[]) => void) | null)[];
    private pendingSpec: LightSpec | null = null;

    constructor(deps: LightManagerDeps) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger });
        this.system = deps.system;
        this.origDestroy = new Array(deps.capacity).fill(null);
    }

    /**
     * Add a dynamic point or spot light.
     * @returns the light handle, or `null` when the pool is full.
     */
    add(spec: LightSpec): LightHandle | null {
        this.pendingSpec = spec;
        const allocated = this.allocateHandle();
        this.pendingSpec = null;
        return allocated ? allocated.handle : null;
    }

    /** Set the global ambient term. Defaults to `(0.3, 0.3, 0.3)`. */
    ambient(color: readonly [number, number, number]): void {
        this.system.setAmbient(color);
    }

    /**
     * Set the global directional light (the "sun"). Sugar for adding the single
     * directional term; `direction` points from the surface toward the light.
     */
    sun(
        direction: readonly [number, number, number],
        color: readonly [number, number, number] = [1, 1, 1],
        intensity = 1,
    ): void {
        this.system.setDirectional(direction, color, intensity);
    }

    /**
     * Snapshot curr -> prev for every live light.
     * @internal Called by the renderer's pre-tick, not for direct user calls.
     */
    storePrevious(): void {
        this.system.storePrevious();
    }

    /** @internal Sun direction, read by the shadow pass. */
    get sunDirection(): readonly [number, number, number] {
        return this.system.sunDirection;
    }

    /** @internal Assign spot-shadow map slots; returns the caster count. */
    assignSpotShadows(max: number): number {
        return this.system.assignSpotShadows(max);
    }

    /** @internal Assign point-shadow map slots; returns the caster count. */
    assignPointShadows(max: number): number {
        return this.system.assignPointShadows(max);
    }

    /**
     * @internal Pack live lights, upload the light buffer, and write the light
     * block of the scene uniforms. Returns the packed light count.
     */
    upload(device: GPUDevice, lightBuffer: GPUBuffer, uniformData: Float32Array, offset: number): number {
        const packed = this.system.pack();
        if (packed.count > 0) {
            device.queue.writeBuffer(lightBuffer, 0, packed.data.buffer, packed.data.byteOffset, packed.byteLength);
        }
        this.system.writeUniforms(uniformData, offset, packed.count);
        return packed.count;
    }

    /** @internal Spot caster poses for the spot shadow pass. */
    get spotCasters(): LightSystem['spotCasters'] {
        return this.system.spotCasters;
    }

    /** @internal Point caster poses for the point shadow pass. */
    get pointCasters(): LightSystem['pointCasters'] {
        return this.system.pointCasters;
    }

    protected destroySlot(slot: number): void {
        this.origDestroy[slot]?.();
        this.origDestroy[slot] = null;
    }

    protected createHandle(id: LightId, slot: number): LightHandle {
        const raw = this.system.add(this.pendingSpec!, id);
        const orig = raw.destroy.bind(raw);
        this.origDestroy[slot] = orig;
        Object.defineProperty(raw, 'alive', { configurable: true, get: () => this.has(id) });
        raw.destroy = () => this.remove(id);
        return raw;
    }

}

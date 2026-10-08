import { PooledCollection } from '../../collection/pooled-collection';
import type { EmitterId } from '../../collection/ids';
import type { Logger } from 'murow/core';
import type { Frustum } from '../../internals/frustum';
import {
    ParticleSystem3D,
    type ParticleEmitter3D,
    type ParticleEmitter3DOptions,
} from './particle-system-3d';
import type { Handles } from '../../handles';

type ParticleEmitter = Handles.ParticleEmitter;
type Capacity = { maxEmitters: number; maxParticles: number };

/** Dependencies of `ParticleManager`. */
export interface ParticleManagerDeps {
    capacity: Capacity;
    logger: Logger;
    system: ParticleSystem3D;
}

/**
 * ParticleManager is the public facade over `ParticleSystem3D`. It owns the
 * versioned emitter identity space; the system owns the GPU particle pool and
 * compute passes.
 */
export class ParticleManager extends PooledCollection<EmitterId, ParticleEmitter, Capacity> {
    /** The particle system, read by the renderer's pass sequencing. */
    readonly system: ParticleSystem3D;
    private readonly rawEmitters: (ParticleEmitter3D | null)[];
    private pendingSpec: ParticleEmitter3DOptions | null = null;

    constructor(deps: ParticleManagerDeps) {
        super({ poolSize: deps.capacity.maxEmitters, capacity: deps.capacity, logger: deps.logger });
        this.system = deps.system;
        this.rawEmitters = new Array(deps.capacity.maxEmitters).fill(null);
    }

    /**
     * Register an emitter.
     * @returns the emitter handle, or `null` when the emitter pool is full.
     */
    addEmitter(spec: ParticleEmitter3DOptions = {}): ParticleEmitter | null {
        this.pendingSpec = spec;
        const allocated = this.allocateHandle();
        this.pendingSpec = null;
        return allocated ? allocated.handle : null;
    }

    /** Global spawn-rate multiplier for quality scaling. */
    get rateScale(): number { return this.system.rateScale; }
    set rateScale(value: number) { this.system.rateScale = value; }

    /** Global particle size multiplier for quality scaling. */
    get sizeScale(): number { return this.system.sizeScale; }
    set sizeScale(value: number) { this.system.sizeScale = value; }

    /** Spawned high-water mark (draw instance count), not a live count. */
    get particleCount(): number { return this.system.count; }

    /** Advance the pool once per frame (spawns queued by emitter.update). */
    simulate(deltaTime: number): void {
        this.system.simulate(deltaTime);
    }

    /** Draw every particle batch into the current render pass. */
    draw(pass: GPURenderPassEncoder, viewProj: Float32Array, right: ArrayLike<number>, up: ArrayLike<number>): void {
        this.system.draw(pass, viewProj, right, up);
    }

    /** Set the frustum used to cull emitter spawning. */
    setCullFrustum(frustum: Frustum | null): void {
        this.system.setCullFrustum(frustum);
    }

    protected destroySlot(slot: number): void {
        const raw = this.rawEmitters[slot];
        if (raw) this.system.removeEmitter(raw);
        this.rawEmitters[slot] = null;
    }

    protected createHandle(id: EmitterId, slot: number): ParticleEmitter {
        const raw = this.system.addEmitter(this.pendingSpec ?? {});
        this.rawEmitters[slot] = raw;
        const emitter = raw as unknown as ParticleEmitter;
        (emitter as unknown as { id: EmitterId }).id = id;
        Object.defineProperty(emitter, 'alive', { configurable: true, get: () => this.has(id) });
        emitter.setPosition = (x: number, y: number, z: number) => {
            raw.position[0] = x; raw.position[1] = y; raw.position[2] = z;
        };
        emitter.setRotation = (x: number, y: number, z: number) => {
            raw.direction[0] = x; raw.direction[1] = y; raw.direction[2] = z;
        };
        (raw as unknown as { destroy(): void }).destroy = () => this.remove(id);
        return emitter;
    }

}

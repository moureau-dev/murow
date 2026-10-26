/**
 * CameraRegistry — a dense set of cameras with one primary.
 *
 * Uses the shared `SlotMap` so ids are recycled and iteration is packed. The
 * registry is setup-time: create cameras at start, then call `ordered()` from
 * the render loop, which reuses one scratch array.
 */

import { EventSystem } from 'murow/core/events';
import { SlotMap } from 'murow/core/slot-map';
import type { Logger } from 'murow/core';
import type { CameraRect, ClearColor } from '../../../types';
import type { CameraId } from '../../types';

const UNREGISTERED = -1 as CameraId;
const NOOP = (): void => {};

/** The camera surface the registry needs. Both Camera3D and Camera2D satisfy it. */
export interface RegisteredCamera {
    id: CameraId;
    enabled: boolean;
    priority: number;
    rect: CameraRect;
    clearColor?: ClearColor | false;
    clearDepth: boolean;
    mask: number;
    destroy(): void;
    storePrevious(): void;
    interpolate(alpha: number): void;
}

/** Events emitted by a camera registry. */
export type CameraRegistryEvents<T> = [
    ['add', T],
    ['remove', T],
    ['primary', T],
];

/** Builds a camera for {@link CameraRegistry.create}. */
export type CameraFactory<T extends RegisteredCamera, P> = (props: P) => T;

export class CameraRegistry<T extends RegisteredCamera, P = Record<string, never>> {
    /** Maximum number of registered cameras. */
    readonly capacity: number;
    /** Lifecycle events for cameras. */
    readonly events: EventSystem<CameraRegistryEvents<T>>;

    private readonly factory: CameraFactory<T, P> | undefined;
    private readonly logger: Logger | undefined;
    private readonly slots: SlotMap;
    private readonly cameras: (T | null)[];
    private readonly allCameras: T[] = [];
    private readonly orderedCameras: T[] = [];
    private primaryId = -1;

    /**
     * @param capacity Maximum registered cameras. Must be at least 1.
     * @param factory Builds a camera for `create`. Omit when cameras are added
     *                with `add` and `create` is not used.
     * @param logger Optional logger for capacity and lifecycle errors.
     */
    constructor(capacity: number, factory?: CameraFactory<T, P>, logger?: Logger) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error(`CameraRegistry: capacity must be a positive integer (got ${capacity})`);
        }
        this.capacity = capacity;
        this.factory = factory;
        this.logger = logger;
        this.slots = new SlotMap(capacity);
        this.cameras = new Array<T | null>(capacity).fill(null);
        this.events = new EventSystem<CameraRegistryEvents<T>>({
            events: ['add', 'remove', 'primary'],
        });
    }

    /** Register an existing camera. Throws when the registry is full. */
    add(camera: T): T {
        if (camera.id !== UNREGISTERED) throw new Error('CameraRegistry: camera is already registered');
        const id = this.slots.add();
        if (id === -1) {
            const message = `CameraRegistry capacity (${this.capacity}) reached`;
            this.logger?.error(message);
            throw new Error(message);
        }
        camera.id = id as CameraId;
        camera.destroy = () => {
            if (!this.remove(camera)) {
                const message = 'CameraRegistry: cannot destroy the last camera';
                this.logger?.error(message);
                throw new Error(message);
            }
        };
        this.cameras[id] = camera;
        if (this.primaryId === -1) this.primaryId = id;
        this.events.emit('add', camera);
        return camera;
    }

    /** Build and register a camera. Throws when the registry is full. */
    create(props: P): T {
        if (!this.factory) throw new Error('CameraRegistry: create() requires a factory');
        return this.add(this.factory(props));
    }

    /** Camera by id, or `undefined`. */
    get(id: CameraId): T | undefined {
        return this.slots.has(id) ? (this.cameras[id] ?? undefined) : undefined;
    }

    /** Whether an id is live. */
    has(id: CameraId): boolean {
        return this.slots.has(id);
    }

    /** The primary camera, or `undefined` when the registry is empty. */
    get primary(): T | undefined {
        if (this.primaryId === -1 || !this.slots.has(this.primaryId)) return undefined;
        return this.cameras[this.primaryId] ?? undefined;
    }

    /** Number of registered cameras. */
    get count(): number {
        return this.slots.size;
    }

    /** Change the primary camera. Returns `false` when it is not registered. */
    setPrimary(target: T | CameraId): boolean {
        const id = typeof target === 'number' ? target : target.id;
        if (!this.slots.has(id)) return false;
        this.primaryId = id;
        this.events.emit('primary', this.cameras[id]!);
        return true;
    }

    /**
     * Remove a camera. The registry keeps at least one camera, so removing the
     * last one returns `false`. The primary moves to the next live camera when
     * it is removed.
     */
    remove(target: T | CameraId): boolean {
        const id = typeof target === 'number' ? target : target.id;
        if (!this.slots.has(id) || this.slots.size === 1) return false;
        const camera = this.cameras[id]!;
        this.cameras[id] = null;
        this.slots.remove(id);
        camera.id = UNREGISTERED;
        camera.destroy = NOOP;
        if (this.primaryId === id) {
            this.primaryId = this.slots.activeSlots[0]!;
            this.events.emit('primary', this.cameras[this.primaryId]!);
        }
        this.events.emit('remove', camera);
        return true;
    }

    /** Every camera in packed slot order. Returns a reused array; do not retain. */
    all(): readonly T[] {
        const out = this.allCameras;
        out.length = 0;
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) out.push(this.cameras[active[i]!]!);
        return out;
    }

    /** Visit every camera without allocating. */
    each(visit: (camera: T) => void): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) visit(this.cameras[active[i]!]!);
    }

    /**
     * Enabled cameras in draw order: ascending priority, then packed slot order.
     * Returns a reused array; do not retain it.
     */
    ordered(): readonly T[] {
        const out = this.orderedCameras;
        out.length = 0;
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const camera = this.cameras[active[i]!]!;
            if (!camera.enabled) continue;
            let j = out.length;
            while (j > 0 && out[j - 1]!.priority > camera.priority) {
                out[j] = out[j - 1]!;
                j--;
            }
            out[j] = camera;
        }
        return out;
    }

    /** Snapshot previous state for every camera. */
    storePrevious(): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) this.cameras[active[i]!]!.storePrevious();
    }

    /** Interpolate every camera toward its current state. */
    interpolate(alpha: number): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) this.cameras[active[i]!]!.interpolate(alpha);
    }
}

import type { Hitbox } from 'murow/core/hitbox';
import type { Ray3D } from 'murow/core/ray';
import { testHitbox3D } from 'murow/core/hitbox';
import type { Camera3D } from '../../../../camera/camera-3d';
import type { MeshInstanceHandle } from '../../types';

/** Destination for collected hits (structurally satisfied by `RaycastState`). */
export interface RaycastSink {
    push(
        handle: MeshInstanceHandle,
        distance: number,
        x: number, y: number, z: number,
        t: number,
        part: string | null,
    ): void;
}

/** What the controller needs from the renderer: instance iteration + hitboxes. */
export interface RaycastTarget {
    readonly camera: Camera3D;
    /**
     * Visit every live instance (non-skinned and skinned) with its world
     * position, scale, and model half-extents.
     */
    eachInstance(visit: (
        handle: MeshInstanceHandle,
        cx: number, cy: number, cz: number,
        sx: number, sy: number, sz: number,
        halfX: number, halfY: number, halfZ: number,
        centerX: number, centerY: number, centerZ: number,
    ) => void): void;
    /** The instance's declared hitbox, or `null` to use its bounding box. */
    resolveHitbox(handle: MeshInstanceHandle): Hitbox<'3d'> | null;
}

/**
 * RaycastController — tests a screen ray against every instance and pushes
 * the hits within the camera's near/far range into a sink. Unsorted.
 */
export class RaycastController {
    constructor(private readonly target: RaycastTarget) {}

    collect(screenX: number, screenY: number, sink: RaycastSink, camera: Camera3D = this.target.camera): void {
        const ray = camera.screenToRay(screenX, screenY);
        const ox = ray.origin[0], oy = ray.origin[1], oz = ray.origin[2];
        const dx = ray.direction[0], dy = ray.direction[1], dz = ray.direction[2];
        const minDistance = camera.near;
        const maxDistance = camera.far;

        this.target.eachInstance((handle, cx, cy, cz, sx, sy, sz, halfX, halfY, halfZ, centerX, centerY, centerZ) => {
            const hit = this.test(ray, handle, cx, cy, cz, sx, sy, sz, halfX, halfY, halfZ, centerX, centerY, centerZ);
            if (hit === null) return;
            const t = hit.distance;
            if (t < minDistance || t > maxDistance) return;
            sink.push(handle, t, ox + dx * t, oy + dy * t, oz + dz * t, t, hit.part);
        });
    }

    /**
     * Pick test for a single instance. Uses the prefab's declared hitbox when
     * available; falls back to the model's axis-aligned bounding box.
     */
    private test(
        ray: Ray3D,
        handle: MeshInstanceHandle,
        cx: number, cy: number, cz: number,
        sx: number, sy: number, sz: number,
        halfX: number, halfY: number, halfZ: number,
        centerX: number, centerY: number, centerZ: number,
    ): { distance: number; part: string | null } | null {
        const hitbox = this.target.resolveHitbox(handle);
        if (hitbox) {
            const hit = testHitbox3D(ray, hitbox, cx, cy, cz, sx, sy, sz);
            return hit ? { distance: hit.distance, part: hit.part } : null;
        }

        // Default bounds: the model's AABB, whose center is the bbox center
        // (scaled), not the instance origin (e.g. a character's feet).
        const t = ray.entryBox(
            cx + centerX * sx, cy + centerY * sy, cz + centerZ * sz,
            halfX * sx, halfY * sy, halfZ * sz,
        );
        return t === null ? null : { distance: t, part: null };
    }
}

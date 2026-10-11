import type { Frustum } from '../frustum/frustum';

/**
 * SkinCull — decides whether a skinned instance should have its bone-matrix
 * compute dispatched this frame. An instance is skinned only when it is both
 * visible (frustum) and within a configurable distance of the camera; farther
 * instances keep their last computed pose.
 */
export class SkinCull {
    private distanceSq: number;

    constructor(
        private readonly frustum: Frustum,
        distance: number,
    ) {
        this.distanceSq = distance * distance;
    }

    /** Current world-space cull distance (from the camera). */
    get distance(): number {
        return Math.sqrt(this.distanceSq);
    }

    setDistance(distance: number): void {
        this.distanceSq = distance * distance;
    }

    shouldUpdate(
        x: number, y: number, z: number, radius: number,
        camX: number, camY: number, camZ: number,
    ): boolean {
        if (!this.frustum.intersectsSphere(x, y, z, radius)) return false;
        const dx = x - camX;
        const dy = y - camY;
        const dz = z - camZ;
        return dx * dx + dy * dy + dz * dz <= this.distanceSq;
    }
}

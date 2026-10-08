import { testHitbox2D, pointInQuad2D, type Hitbox } from 'murow/core/hitbox';
import type { SpriteHandle } from 'murow/renderer';
import type { Camera2D } from '../../../../camera/camera-2d';

/** Destination for collected hits (structurally satisfied by `RaycastState2D`). */
export interface RaycastSink2D {
    push(
        handle: SpriteHandle,
        distance: number,
        x: number,
        y: number,
        z: number,
        t: number,
        part: string | null,
    ): void;
}

/** What the controller needs from the sprite manager: iteration + hitboxes. */
export interface RaycastTarget2D {
    readonly camera: Camera2D;
    /** Visit every live sprite. */
    eachSprite(visit: (handle: SpriteHandle) => void): void;
    /** The sprite's declared hitbox, or `null` to use its rendered quad. */
    resolveHitbox(handle: SpriteHandle): Hitbox<'2d'> | null;
}

type Point = [number, number];

/**
 * RaycastController2D — point-tests every sprite against the unprojected cursor
 * and pushes hits into a sink. Sort key is `-layer` so the topmost sprite is
 * "nearest". A declared hitbox overrides the default rendered quad.
 */
export class RaycastController2D {
    constructor(private readonly target: RaycastTarget2D) {}

    collect(screenX: number, screenY: number, sink: RaycastSink2D, camera: Camera2D = this.target.camera): void {
        const [wx, wy] = camera.screenToWorld(screenX, screenY);

        this.target.eachSprite((handle) => {
            const hb = this.target.resolveHitbox(handle);
            let part: string | null = null;
            if (hb) {
                const hit = testHitbox2D(hb, handle.x, handle.y, handle.scaleX, handle.scaleY, handle.rotation, wx, wy);
                if (!hit) return;
                part = hit.part;
            } else if (!pointInQuad2D(handle.x, handle.y, handle.scaleX, handle.scaleY, handle.rotation, wx, wy)) {
                return;
            }

            sink.push(handle, -handle.layer, wx, wy, 0, handle.layer, part);
        });
    }
}

export type { Point };

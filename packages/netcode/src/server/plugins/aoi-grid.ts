import type { Component, Entity, World } from 'murow/ecs';
import type { Peer } from '../../ctx';
import type { ServerPlugin } from './plugin';

export interface AoiGridOptions {
    /** Plugin identifier; matches `sync.interest` strings on components. Default `'aoi'`. */
    name?: string;
    /** Reserved for grid acceleration. v1 does a naive radius scan. */
    cellSize: number;
    /** AOI radius around each peer (world units). */
    radius: number;
    /** Extra slack on the despawn boundary. Default 0. */
    hysteresisRadius?: number;
    /** Component holding `{ x, y }` positions used to compute distance. */
    positionComponent: Component<{ x: number; y: number }>;
}

/**
 * Spatial interest plugin. Per-tick, filters dirty entities to those
 * within `radius + hysteresisRadius` of each peer's assigned entity.
 *
 * v1 is O(peers * dirty). A grid accelerator can slot in without
 * changing the public surface.
 */
export class AoiGrid implements ServerPlugin {
    readonly name: string;
    readonly cellSize: number;
    readonly radius: number;
    readonly hysteresisRadius: number;
    private positionComponent: Component<{ x: number; y: number }>;

    constructor(opts: AoiGridOptions) {
        this.name = opts.name ?? 'aoi';
        this.cellSize = opts.cellSize;
        this.radius = opts.radius;
        this.hysteresisRadius = opts.hysteresisRadius ?? 0;
        this.positionComponent = opts.positionComponent;
    }

    filterSnapshot(
        peer: Peer,
        world: World,
        dirtyEntities: ReadonlyArray<Entity>,
        out: Entity[],
    ): void {
        // No entity assigned yet: everything visible.
        if (peer.entity === -1 || !world.has(peer.entity, this.positionComponent)) {
            for (let i = 0; i < dirtyEntities.length; i++) out.push(dirtyEntities[i]);
            return;
        }

        const peerPos = world.get(peer.entity, this.positionComponent);
        const px = peerPos.x;
        const py = peerPos.y;
        const maxR = this.radius + this.hysteresisRadius;
        const maxR2 = maxR * maxR;

        for (let i = 0; i < dirtyEntities.length; i++) {
            const eid = dirtyEntities[i];
            if (!world.has(eid, this.positionComponent)) {
                // No position: pass through (e.g. global-interest entity).
                out.push(eid);
                continue;
            }
            const ep = world.get(eid, this.positionComponent);
            const dx = ep.x - px;
            const dy = ep.y - py;
            if (dx * dx + dy * dy <= maxR2) out.push(eid);
        }
    }
}

import { describe, test, expect } from 'bun:test';
import { f32 } from 'murow/core/binary-codec';
import { defineComponent, World } from 'murow/ecs';
import { AoiGrid } from './aoi-grid';
import type { Peer } from '../../ctx';

const Pos = defineComponent('Pos', { x: f32, y: f32 });
const Box = defineComponent('Box', { hx: f32, hy: f32 });

describe('AoiGrid bounds (AABB) interest', () => {
    test('a large box whose center is outside the radius but overlaps the view still ships', () => {
        const world = new World({ maxEntities: 8, components: [Pos, Box] });
        const aoi = new AoiGrid({ cellSize: 8, radius: 10, positionComponent: Pos, boundsComponent: Box });

        const peerEntity = world.spawn();
        world.add(peerEntity, Pos, { x: 0, y: 0 });
        world.add(peerEntity, Box, { hx: 0, hy: 0 });

        const big = world.spawn();
        world.add(big, Pos, { x: 14, y: 0 });
        world.add(big, Box, { hx: 8, hy: 8 }); // AABB [6,22] x [-8,8], overlaps view [-10,10]

        const far = world.spawn();
        world.add(far, Pos, { x: 40, y: 0 });
        world.add(far, Box, { hx: 1, hy: 1 }); // no overlap

        aoi.onTick(world);
        const peer: Peer = { peerId: 'p', entity: peerEntity };

        const filtered: number[] = [];
        aoi.filterSnapshot(peer, world, [big, far], filtered);
        expect(filtered).toContain(big);
        expect(filtered).not.toContain(far);

        const near: number[] = [];
        aoi.nearby(peer, world, near);
        expect(near).toContain(big);
        expect(near).not.toContain(far);
    });

    test('without boundsComponent, interest stays center-distance', () => {
        const world = new World({ maxEntities: 8, components: [Pos] });
        const aoi = new AoiGrid({ cellSize: 8, radius: 10, positionComponent: Pos });

        const peerEntity = world.spawn();
        world.add(peerEntity, Pos, { x: 0, y: 0 });
        const near = world.spawn();
        world.add(near, Pos, { x: 5, y: 0 });
        const outside = world.spawn();
        world.add(outside, Pos, { x: 14, y: 0 });

        aoi.onTick(world);
        const out: number[] = [];
        aoi.filterSnapshot({ peerId: 'p', entity: peerEntity }, world, [near, outside], out);
        expect(out).toContain(near);
        expect(out).not.toContain(outside);
    });
});

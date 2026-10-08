import { test, expect, describe } from 'bun:test';
import { Ray3D } from 'murow/core/ray';
import { Camera3D } from '../../../../camera/camera-3d';
import { RaycastController, type RaycastTarget, type RaycastSink } from './raycast-controller';
import type { MeshInstanceHandle } from '../../types';

const handle = { id: 1 } as MeshInstanceHandle;

function makeTarget(screenRay: Ray3D, far = 100): RaycastTarget {
    const camera = new Camera3D();
    camera.near = 0;
    camera.far = far;
    camera.screenToRay = () => screenRay;
    return {
        camera,
        eachInstance: (visit) => visit(handle, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0),
        resolveHitbox: () => null,
    };
}

function makeSink() {
    const hits: number[] = [];
    const sink: RaycastSink = { push: (_h, distance) => { hits.push(distance); } };
    return { sink, hits };
}

describe('RaycastController', () => {
    test('pushes a hit within near/far', () => {
        const ray = new Ray3D();
        ray.set(0, 0, -5, 0, 0, 1);
        const { sink, hits } = makeSink();
        new RaycastController(makeTarget(ray)).collect(0, 0, sink);
        expect(hits.length).toBe(1);
        expect(hits[0]).toBeCloseTo(4);
    });

    test('rejects hits past far', () => {
        const ray = new Ray3D();
        ray.set(0, 0, -5, 0, 0, 1);
        const { sink, hits } = makeSink();
        new RaycastController(makeTarget(ray, 2)).collect(0, 0, sink);
        expect(hits.length).toBe(0);
    });

    test('default bounds are centered on the model bbox center, not the origin', () => {
        const target = (centerY: number): RaycastTarget => {
            const camera = new Camera3D();
            camera.near = 0;
            camera.far = 100;
            return {
                camera,
                // origin at y=0 (feet), bbox center y=centerY, half-height 0.5
                eachInstance: (visit) => visit(handle, 0, 0, 0, 1, 1, 1, 1, 0.5, 1, 0, centerY, 0),
                resolveHitbox: () => null,
            } as unknown as RaycastTarget;
        };
        const cast = (ray: Ray3D, centerY: number) => {
            const t = target(centerY);
            (t.camera as unknown as { screenToRay: () => Ray3D }).screenToRay = () => ray;
            const { sink, hits } = makeSink();
            new RaycastController(t).collect(0, 0, sink);
            return hits.length;
        };

        const atCenter = new Ray3D();
        atCenter.set(0, 1, -5, 0, 0, 1);
        expect(cast(atCenter, 1)).toBe(1); // box now covers y in [0.5, 1.5]

        const atFeet = new Ray3D();
        atFeet.set(0, 0, -5, 0, 0, 1);
        expect(cast(atFeet, 1)).toBe(0); // origin is below the centered box
    });
});

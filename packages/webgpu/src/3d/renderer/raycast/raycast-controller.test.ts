import { test, expect, describe } from 'bun:test';
import { Ray3D } from 'murow/core/ray';
import { Camera3D } from '../../../camera/camera-3d';
import { RaycastController, type RaycastTarget, type RaycastSink } from './raycast-controller';
import type { MeshInstanceHandle } from '../types';

const handle = { id: 1 } as MeshInstanceHandle;

function makeTarget(screenRay: Ray3D, far = 100): RaycastTarget {
    const camera = new Camera3D();
    camera.near = 0;
    camera.far = far;
    camera.screenToRay = () => screenRay;
    return {
        camera,
        eachInstance: (visit) => visit(handle, 0, 0, 0, 1, 1, 1, 1, 1, 1),
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
});

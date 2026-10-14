import { describe, expect, test } from 'bun:test';
import { OcclusionTrackerImpl } from './occlusion-tracker';

const vis = (staticVis: number[], skinnedVis: number[]) => ({
    static: new Uint32Array(staticVis),
    skinned: new Uint32Array(skinnedVis),
});

describe('OcclusionTrackerImpl', () => {
    test('reports visible before the first readback', () => {
        const hero = { slot: 3, skinned: true };
        const tracker = new OcclusionTrackerImpl([hero]);
        expect(tracker.isOccluded(hero)).toBe(false);
    });

    test('reads skinned slots from the skinned buffer', () => {
        const hero = { slot: 2, skinned: true };
        const tracker = new OcclusionTrackerImpl([hero]);
        tracker.apply(vis([1, 1, 1], [1, 1, 0]));
        expect(tracker.isOccluded(hero)).toBe(true);
    });

    test('reads static slots from the static buffer', () => {
        const rock = { slot: 1 };
        const tracker = new OcclusionTrackerImpl([rock]);
        tracker.apply(vis([1, 0], [1]));
        expect(tracker.isOccluded(rock)).toBe(true);
    });

    test('fail-open for a destroyed handle', () => {
        const hero = { slot: 0, skinned: true, destroyed: true };
        const tracker = new OcclusionTrackerImpl([hero]);
        tracker.apply(vis([0], [0]));
        expect(tracker.isOccluded(hero)).toBe(false);
    });

    test('unknown handles read as visible', () => {
        const tracker = new OcclusionTrackerImpl([{ slot: 0 }]);
        tracker.apply(vis([0], [0]));
        expect(tracker.isOccluded({ slot: 99 })).toBe(false);
    });

    test('release invokes the callback', () => {
        let released = false;
        new OcclusionTrackerImpl([], () => { released = true; }).release();
        expect(released).toBe(true);
    });
});

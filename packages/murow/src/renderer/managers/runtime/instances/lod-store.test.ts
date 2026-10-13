import { describe, test, expect } from 'bun:test';
import { DYNAMIC_MESH_FLOATS } from '../engine-core/types';
import { DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ, DYN_MORPH } from './offsets';
import { InstanceLodStore } from './lod-store';

function positions(n: number) {
    return new Float32Array(n * DYNAMIC_MESH_FLOATS);
}
function setPos(dyn: Float32Array, slot: number, x: number, y: number, z: number) {
    const b = slot * DYNAMIC_MESH_FLOATS;
    dyn[b + DYN_CURR_PX] = x;
    dyn[b + DYN_CURR_PY] = y;
    dyn[b + DYN_CURR_PZ] = z;
}

describe('InstanceLodStore', () => {
    test('selects by distance and reports the applied model swap', () => {
        const lod = new InstanceLodStore(4);
        const dyn = positions(4);
        setPos(dyn, 0, 0, 0, 0);
        lod.setLevels({ slot: 0, modelIds: [7, 8, 9], distSq: [100, 10000, Infinity] });

        const applied: [number, number][] = [];
        const apply = (slot: number, id: number) => applied.push([slot, id]);

        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, apply)).toBe(0);
        expect(lod.levelOf(0)).toBe(0);

        setPos(dyn, 0, 20, 0, 0);                         // d² 400 > 100
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, apply)).toBe(1);
        expect(lod.levelOf(0)).toBe(1);
        expect(applied).toEqual([[0, 8]]);

        setPos(dyn, 0, 200, 0, 0);                        // d² 40000 > 10000
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, apply)).toBe(1);
        expect(lod.levelOf(0)).toBe(2);
        expect(applied).toEqual([[0, 8], [0, 9]]);
    });

    test('hysteresis suppresses flip-flop at the boundary', () => {
        const lod = new InstanceLodStore(2);
        const dyn = positions(2);
        lod.setLevels({ slot: 0, modelIds: [7, 8], distSq: [100, Infinity] });
        const noop = () => {};

        setPos(dyn, 0, 10, 0, 0);                         // d² 100, at boundary
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, noop)).toBe(0);
        setPos(dyn, 0, 10.4, 0, 0);                       // d² 108.16, inside +10%
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, noop)).toBe(0);
        setPos(dyn, 0, 11, 0, 0);                         // d² 121, past +10%
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, noop)).toBe(1);
    });

    test('bias scales every authored distance', () => {
        const lod = new InstanceLodStore(2);
        const dyn = positions(2);
        lod.setLevels({ slot: 0, modelIds: [7, 8], distSq: [100, Infinity] });
        const noop = () => {};
        setPos(dyn, 0, 15, 0, 0);                         // d² 225
        expect(lod.select(dyn, 0, 0, 0, 2, 0.1, noop)).toBe(0); // bias 2 → boundary 400
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, noop)).toBe(1); // bias 1 → crosses 100
    });

    test('setLevels below two levels is a no-op; clear forgets a slot', () => {
        const lod = new InstanceLodStore(2);
        lod.setLevels({ slot: 0, modelIds: [7], distSq: [Infinity] });
        expect(lod.slots.size).toBe(0);

        lod.setLevels({ slot: 0, modelIds: [7, 8], distSq: [100, Infinity] });
        expect(lod.slots.size).toBe(1);
        lod.clear(0);
        expect(lod.slots.size).toBe(0);
        expect(lod.levelOf(0)).toBe(0);
    });
});

describe('InstanceLodStore geomorph', () => {
    test('fades between adjacent levels when fadeTicks > 0', () => {
        const lod = new InstanceLodStore(2);
        const dyn = positions(2);
        lod.setLevels({ slot: 0, modelIds: [7, 8, 9], distSq: [100, 10000, Infinity] });
        lod.fadeTicks = 4;

        const applied: [number, number][] = [];
        const apply = (slot: number, id: number) => applied.push([slot, id]);

        setPos(dyn, 0, 20, 0, 0);                                  // d² 400 → level 1 (adjacent)
        expect(lod.select(dyn, 0, 0, 0, 1, 0.1, apply)).toBe(1);
        expect(applied).toEqual([[0, 7]]);                          // batch held at lo (level 0)
        expect(dyn[DYN_MORPH]).toBe(0);

        lod.advanceFades(dyn, apply);
        expect(dyn[DYN_MORPH]).toBeCloseTo(0.25);
        lod.advanceFades(dyn, apply);
        expect(dyn[DYN_MORPH]).toBeCloseTo(0.5);
        lod.advanceFades(dyn, apply);
        lod.advanceFades(dyn, apply);                              // settle → level 1
        expect(lod.levelOf(0)).toBe(1);
        expect(applied[applied.length - 1]).toEqual([0, 8]);
        expect(dyn[DYN_MORPH]).toBe(0);
    });

    test('refining starts the morph at 1 (fully the higher level) and ramps down', () => {
        const lod = new InstanceLodStore(2);
        const dyn = positions(2);
        lod.setLevels({ slot: 0, modelIds: [7, 8], distSq: [100, Infinity] });
        lod.fadeTicks = 2;
        const apply = () => {};

        setPos(dyn, 0, 20, 0, 0);
        lod.select(dyn, 0, 0, 0, 1, 0.1, apply);                    // 0 → 1
        lod.advanceFades(dyn, apply);
        lod.advanceFades(dyn, apply);                              // settle at level 1
        expect(lod.levelOf(0)).toBe(1);

        setPos(dyn, 0, 0, 0, 0);                                    // near → refine to 0
        lod.select(dyn, 0, 0, 0, 1, 0.1, apply);
        expect(dyn[DYN_MORPH]).toBe(1);                             // starts fully at level 1
        lod.advanceFades(dyn, apply);
        expect(dyn[DYN_MORPH]).toBeCloseTo(0.5);
        lod.advanceFades(dyn, apply);
        expect(lod.levelOf(0)).toBe(0);
        expect(dyn[DYN_MORPH]).toBe(0);
    });
});

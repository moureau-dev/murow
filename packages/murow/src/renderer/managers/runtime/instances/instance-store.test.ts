import { test, expect, describe } from 'bun:test';
import { DYNAMIC_MESH_FLOATS } from '../engine-core/types';
import { InstanceStore } from './instance-store';
import type { ModelHandle } from '../../types';
import { DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ, DYN_PREV_PX } from './offsets';

const model: ModelHandle = { id: 7, vertexCount: 3, indexCount: 0, skinned: false };

let idc = 0;
function store() {
    return new InstanceStore({ maxInstances: 4, getTextureBindGroup: () => ({}) as GPUBindGroup });
}

describe('InstanceStore', () => {
    test('spawn writes the transform and returns a usable handle', () => {
        const s = store();
        const h = s.spawn({ prefab: model, position: [1, 2, 3] }, model, null, ++idc);
        expect(h.modelId).toBe(7);
        expect(s.instanceModelIds[h.slot]).toBe(7);

        const base = h.slot * DYNAMIC_MESH_FLOATS;
        expect(s.dynamicData[base + DYN_CURR_PX]).toBe(1);
        expect(s.dynamicData[base + DYN_CURR_PY]).toBe(2);
        expect(s.dynamicData[base + DYN_CURR_PZ]).toBe(3);

        h.setPosition(4, 5, 6);
        expect([...h.position]).toEqual([4, 5, 6]);
    });

    test('storePrevious copies CURR to PREV', () => {
        const s = store();
        const h = s.spawn({ prefab: model, position: [9, 8, 7] }, model, null, ++idc);
        s.storePrevious();
        expect(s.dynamicData[h.slot * DYNAMIC_MESH_FLOATS + DYN_PREV_PX]).toBe(9);
    });

    test('destroy frees the slot for reuse', () => {
        const s = store();
        const h = s.spawn({ prefab: model }, model, null, ++idc);
        h.destroy();
        const again = s.spawn({ prefab: model }, model, null, ++idc);
        expect(again.slot).toBe(h.slot);
    });

    test('throws when capacity is exceeded', () => {
        const s = new InstanceStore({ maxInstances: 1, getTextureBindGroup: () => undefined });
        s.spawn({ prefab: model }, model, null, ++idc);
        expect(() => s.spawn({ prefab: model }, model, null, ++idc)).toThrow('Max instances');
    });

    test('exposes live slots densely for O(live) iteration', () => {
        const s = store();
        const a = s.spawn({ prefab: model }, model, null, ++idc);
        const b = s.spawn({ prefab: model }, model, null, ++idc);
        const c = s.spawn({ prefab: model }, model, null, ++idc);
        b.destroy();

        expect(s.slots.size).toBe(2);
        const live: number[] = [];
        for (let i = 0; i < s.slots.size; i++) live.push(s.slots.activeSlots[i]!);
        expect(live.sort((x, y) => x - y)).toEqual([a.slot, c.slot].sort((x, y) => x - y));
        expect(s.slots.has(b.slot)).toBe(false);
    });

    test('clear empties the live set', () => {
        const s = store();
        s.spawn({ prefab: model }, model, null, ++idc);
        s.spawn({ prefab: model }, model, null, ++idc);
        s.slots.clear();
        expect(s.slots.size).toBe(0);
    });
});

describe('InstanceStore LOD', () => {
    const base: ModelHandle = { id: 7, vertexCount: 3, indexCount: 0, skinned: false };
    const mid: ModelHandle = { id: 8, vertexCount: 2, indexCount: 0, skinned: false };
    const low: ModelHandle = { id: 9, vertexCount: 1, indexCount: 0, skinned: false };

    /** model id -> slots currently batched under it. */
    function batched(s: InstanceStore): Map<number, number[]> {
        const out = new Map<number, number[]>();
        s.batcher.each((modelId, instances, count) => {
            const arr: number[] = [];
            for (let i = 0; i < count; i++) arr.push(instances[i]!);
            out.set(modelId, arr);
        });
        return out;
    }

    test('selects a level by distance and moves the batcher bucket', () => {
        const s = store();
        const h = s.spawn({ prefab: base, position: [0, 0, 0] }, base, null, ++idc);
        s.setLodLevels({ slot: h.slot, modelIds: [base.id, mid.id, low.id], distSq: [100, 10000, Infinity] });

        expect(s.selectLod(0, 0, 0)).toBe(0);            // near → level 0
        expect(s.instanceModelIds[h.slot]).toBe(7);

        expect(s.selectLod(20, 0, 0)).toBe(1);           // d²=400 > 100 → level 1
        expect(s.instanceModelIds[h.slot]).toBe(8);
        expect(s.lodLevelOf(h.slot)).toBe(1);
        expect(batched(s).get(8)).toEqual([h.slot]);     // moved out of model 7's bucket

        expect(s.selectLod(200, 0, 0)).toBe(1);          // d²=40000 > 10000 → level 2
        expect(s.instanceModelIds[h.slot]).toBe(9);
    });

    test('hysteresis suppresses flip-flop at the boundary', () => {
        const s = store();
        const h = s.spawn({ prefab: base }, base, null, ++idc);
        s.setLodLevels({ slot: h.slot, modelIds: [base.id, mid.id], distSq: [100, Infinity] });

        h.setPosition(10, 0, 0);                          // d² = 100 (at boundary) → stays level 0
        expect(s.selectLod(0, 0, 0, 1, 0.1)).toBe(0);

        h.setPosition(10.4, 0, 0);                        // d² = 108.16 (within +10%) → no change
        expect(s.selectLod(0, 0, 0, 1, 0.1)).toBe(0);

        h.setPosition(11, 0, 0);                          // d² = 121 (> 110) → swap
        expect(s.selectLod(0, 0, 0, 1, 0.1)).toBe(1);
    });

    test('bias scales every authored distance', () => {
        const s = store();
        const h = s.spawn({ prefab: base }, base, null, ++idc);
        s.setLodLevels({ slot: h.slot, modelIds: [base.id, mid.id], distSq: [100, Infinity] });
        h.setPosition(15, 0, 0);                          // d² = 225
        expect(s.selectLod(0, 0, 0, 2, 0.1)).toBe(0);     // bias 2 → boundary at 400
        expect(s.selectLod(0, 0, 0, 1, 0.1)).toBe(1);     // bias 1 → crosses 100
    });

    test('non-LOD instances are never touched', () => {
        const s = store();
        const a = s.spawn({ prefab: base, position: [0, 0, 0] }, base, null, ++idc);
        const b = s.spawn({ prefab: base, position: [0, 0, 0] }, base, null, ++idc);
        s.setLodLevels({ slot: a.slot, modelIds: [base.id, mid.id], distSq: [100, Infinity] });
        expect(s.selectLod(1e6, 0, 0, 1, 0.1)).toBe(1);   // only `a` swaps
        expect(s.instanceModelIds[a.slot]).toBe(8);
        expect(s.instanceModelIds[b.slot]).toBe(7);
    });

    test('destroying a LOD instance removes it from the LOD set', () => {
        const s = store();
        const h = s.spawn({ prefab: base }, base, null, ++idc);
        s.setLodLevels({ slot: h.slot, modelIds: [base.id, mid.id], distSq: [100, Infinity] });
        expect(s.lod.slots.size).toBe(1);
        h.destroy();
        expect(s.lod.slots.size).toBe(0);
        expect(s.selectLod(1e6, 0, 0, 1, 0.1)).toBe(0);
    });
});

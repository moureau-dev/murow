import { test, expect, describe } from 'bun:test';
import { DYNAMIC_MESH_FLOATS } from '../../../../core/types';
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

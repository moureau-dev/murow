import { test, expect, describe } from 'bun:test';
import { SkinnedInstanceStore, type SkinModelLike } from './skinned-instance-store';
import type { ModelHandle } from '../../types';
import { LayerRegistry } from '../../../layers';

const model: ModelHandle = { id: 3, vertexCount: 3, indexCount: 0, skinned: true };

function skinModel(): SkinModelLike {
    return {
        jointCount: 2,
        animation: {
            clipCount: 0,
            createState: (() => ({})) as any,
            play: () => {},
            stop: () => {},
            computeRestPose: () => {},
        },
    };
}

function store() {
    return new SkinnedInstanceStore({
        maxSkinnedInstances: 8,
        maxTotalBones: 64,
        maxSkins: 4,
        layers: new LayerRegistry(),
        uploadRestPose: () => {},
        getTextureBindGroup: () => undefined,
    });
}

let idc = 0;
function spawn(s: SkinnedInstanceStore) {
    return s.spawn({ prefab: model }, model, 0, skinModel(), undefined, null, [0], ++idc);
}

describe('SkinnedInstanceStore', () => {
    test('exposes live slots densely for O(live) iteration', () => {
        const s = store();
        const a = spawn(s);
        const b = spawn(s);
        const c = spawn(s);
        b.destroy();

        expect(s.slots.size).toBe(2);
        const live: number[] = [];
        for (let i = 0; i < s.slots.size; i++) live.push(s.slots.activeSlots[i]!);
        expect(live.sort((x, y) => x - y)).toEqual([a.slot, c.slot].sort((x, y) => x - y));
        expect(s.slots.has(b.slot)).toBe(false);
    });

    test('a destroyed slot is reused by the next spawn', () => {
        const s = store();
        const a = spawn(s);
        a.destroy();
        const again = spawn(s);
        expect(again.slot).toBe(a.slot);
        expect(s.slots.size).toBe(1);
    });

    test('clear empties the live set', () => {
        const s = store();
        spawn(s);
        spawn(s);
        s.slots.clear();
        expect(s.slots.size).toBe(0);
    });
});

describe('SkinnedInstanceStore LOD', () => {
    test('setLodLevels + selectLod move the skinned batcher bucket', () => {
        const s = store();
        const h = spawn(s); // model id 3
        s.setLodLevels({ slot: h.slot, modelIds: [3, 8], distSq: [100, Infinity] });
        expect(s.lodLevelOf(h.slot)).toBe(0);

        h.setPosition(20, 0, 0);                        // d² 400 > 100
        expect(s.selectLod(0, 0, 0)).toBe(1);
        expect(s.instanceModelIds[h.slot]).toBe(8);
        expect(s.lodLevelOf(h.slot)).toBe(1);

        const batched: number[] = [];
        s.batcher.each((modelId, _instances, count) => {
            for (let i = 0; i < count; i++) batched.push(modelId);
        });
        expect(batched).toContain(8);
        expect(batched).not.toContain(3);
    });

    test('destroying a LOD skinned instance clears its levels', () => {
        const s = store();
        const h = spawn(s);
        s.setLodLevels({ slot: h.slot, modelIds: [3, 8], distSq: [100, Infinity] });
        expect(s.lod.slots.size).toBe(1);
        h.destroy();
        expect(s.lod.slots.size).toBe(0);
    });
});

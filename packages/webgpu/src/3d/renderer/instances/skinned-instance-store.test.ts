import { test, expect, describe } from 'bun:test';
import { SkinnedInstanceStore, type SkinModelLike } from './skinned-instance-store';
import type { ModelHandle } from '../types';

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
        uploadRestPose: () => {},
        getTextureBindGroup: () => undefined,
    });
}

let idc = 0;
function spawn(s: SkinnedInstanceStore) {
    return s.spawn({ prefab: model }, model, 0, skinModel(), undefined, null, ++idc);
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

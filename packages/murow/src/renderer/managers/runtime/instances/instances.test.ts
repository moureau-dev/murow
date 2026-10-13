import { test, expect, describe } from 'bun:test';
import { Logger } from 'murow/core/logger';
import { InstanceManager } from './instances';
import { InstanceStore } from './instance-store';
import { SkinnedInstanceStore } from './skinned-instance-store';
import { setPrefabHandle } from './prefab-handle';
import type { ModelHandle } from '../../types';

function mkHandle(id: number): ModelHandle {
    return { id, vertexCount: 1, indexCount: 0, skinned: false };
}

function setup() {
    const prefabs = new Map<string, unknown>();
    const single = (id: string, modelId: number) => {
        const p = { type: 'cube', id } as never;
        setPrefabHandle(p, mkHandle(modelId));
        prefabs.set(id, p);
    };
    const composite = (id: string, partIds: string[]) =>
        prefabs.set(id, { type: 'composite', id, parts: partIds.map((pid) => ({ partId: pid })) });

    single('baseA', 1);
    single('baseB', 2);
    single('lodA', 3);
    single('lodB', 4);
    composite('base', ['baseA', 'baseB']);
    composite('lod', ['lodA', 'lodB']);

    const store = new InstanceStore({ maxInstances: 16, getTextureBindGroup: () => undefined });
    const skinned = new SkinnedInstanceStore({
        maxSkinnedInstances: 0,
        maxTotalBones: 0,
        maxSkins: 0,
        uploadRestPose: () => {},
        getTextureBindGroup: () => undefined,
    });
    const models = { get: () => ({ boundingRadius: 1, skinned: false }) } as never;
    const mgr = new InstanceManager({
        capacity: 16,
        poolSize: 16,
        logger: Logger.resolve(false),
        store,
        skinned,
        models,
        prefabs: { get: (id: string) => prefabs.get(id) } as never,
        getSkinModel: () => undefined,
    });
    return { mgr, store };
}

describe('InstanceManager LOD (matching-part chains)', () => {
    test('a composite level gives each part its own chain', () => {
        const { mgr, store } = setup();
        mgr.add({ prefab: 'base', lod: [{ prefabId: 'lod', distance: 50 }] } as never);

        const slots: number[] = [];
        for (let i = 0; i < store.lod.slots.size; i++) slots.push(store.lod.slots.denseBuffer[i]!);
        expect(slots.length).toBe(2);
        expect(slots.every((sl) => store.lodLevelOf(sl) === 0)).toBe(true);

        expect(mgr.selectLod(1000, 0, 0)).toBe(2); // far → both parts swap
        const ids = slots.map((sl) => store.instanceModelIds[sl]!).sort();
        expect(ids).toEqual([3, 4]); // baseA→lodA (3), baseB→lodB (4)
    });

    test('a level with a different part count throws', () => {
        const { mgr } = setup();
        expect(() => mgr.add({ prefab: 'base', lod: [{ prefabId: 'baseA', distance: 10 }] } as never))
            .toThrow('part');
    });
});

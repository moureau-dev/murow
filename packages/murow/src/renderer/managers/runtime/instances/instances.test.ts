import { test, expect, describe } from 'bun:test';
import { Logger } from 'murow/core/logger';
import { InstanceManager } from './instances';
import { InstanceStore } from './instance-store';
import { SkinnedInstanceStore } from './skinned-instance-store';
import { setPrefabHandle } from './prefab-handle';
import type { ModelHandle } from '../../types';

function setup() {
    const prefabs = new Map<string, unknown>();
    const modelsById = new Map<number, { boundingRadius: number; skinned: boolean; skinIndex: number }>();
    const single = (id: string, modelId: number, skinned = false, skinIndex = -1) => {
        modelsById.set(modelId, { boundingRadius: 1, skinned, skinIndex });
        const p = { type: 'cube', id } as never;
        setPrefabHandle(p, { id: modelId, vertexCount: 1, indexCount: 0, skinned } as ModelHandle);
        prefabs.set(id, p);
    };
    const composite = (id: string, partIds: string[]) =>
        prefabs.set(id, { type: 'composite', id, parts: partIds.map((pid) => ({ partId: pid })) });

    const store = new InstanceStore({ maxInstances: 32, getTextureBindGroup: () => undefined });
    const skinned = new SkinnedInstanceStore({
        maxSkinnedInstances: 8,
        maxTotalBones: 64,
        maxSkins: 4,
        uploadRestPose: () => {},
        getTextureBindGroup: () => undefined,
    });
    const models = {
        get: (id: number) => modelsById.get(id) ?? { boundingRadius: 1, skinned: false, skinIndex: -1 },
    } as never;
    const mgr = new InstanceManager({
        capacity: 32,
        poolSize: 40,
        logger: Logger.resolve(false),
        store,
        skinned,
        models,
        prefabs: { get: (id: string) => prefabs.get(id) } as never,
        getSkinModel: () => undefined,
    });
    const lodSlots = () => {
        const out: number[] = [];
        for (let i = 0; i < store.lod.slots.size; i++) out.push(store.lod.slots.denseBuffer[i]!);
        return out;
    };
    return { mgr, store, single, composite, lodSlots };
}

describe('InstanceManager LOD', () => {
    test('a composite level gives each part its own chain', () => {
        const { mgr, store, single, composite, lodSlots } = setup();
        single('baseA', 1); single('baseB', 2);
        single('lodA', 3); single('lodB', 4);
        composite('base', ['baseA', 'baseB']);
        composite('lod', ['lodA', 'lodB']);

        mgr.add({ prefab: 'base', lod: [{ prefabId: 'lod', distance: 50 }] } as never);
        const slots = lodSlots();
        expect(slots.length).toBe(2);
        expect(slots.every((sl) => store.lodLevelOf(sl) === 0)).toBe(true);

        expect(mgr.selectLod(1000, 0, 0)).toBe(2);
        expect(slots.map((sl) => store.instanceModelIds[sl]!).sort()).toEqual([3, 4]);
    });

    test('nested composites LOD recursively', () => {
        const { mgr, store, single, composite, lodSlots } = setup();
        single('a', 1); single('b', 2); single('a2', 3); single('b2', 4); single('c', 5); single('c2', 6);
        composite('innerBase', ['a', 'b']);
        composite('innerLod', ['a2', 'b2']);
        composite('outerBase', ['innerBase', 'c']);
        composite('outerLod', ['innerLod', 'c2']);

        mgr.add({ prefab: 'outerBase', lod: [{ prefabId: 'outerLod', distance: 50 }] } as never);
        const slots = lodSlots();
        expect(slots.length).toBe(3); // a, b, c — flattened through the nested composite

        expect(mgr.selectLod(1000, 0, 0)).toBe(3);
        expect(slots.map((sl) => store.instanceModelIds[sl]!).sort()).toEqual([3, 4, 6]);
    });

    test('a level with a different part count throws', () => {
        const { mgr, single, composite } = setup();
        single('baseA', 1); single('baseB', 2);
        composite('base', ['baseA', 'baseB']);
        expect(() => mgr.add({ prefab: 'base', lod: [{ prefabId: 'baseA', distance: 10 }] } as never))
            .toThrow('part');
    });

    test('selectLod overrides: enabled=false is a no-op', () => {
        const { mgr, single, composite, lodSlots } = setup();
        single('baseA', 1); single('baseB', 2); single('lodA', 3); single('lodB', 4);
        composite('base', ['baseA', 'baseB']);
        composite('lod', ['lodA', 'lodB']);
        mgr.add({ prefab: 'base', lod: [{ prefabId: 'lod', distance: 50 }] } as never);
        expect(lodSlots().length).toBe(2);
        expect(mgr.selectLod(1000, 0, 0, 1, 0.1, false)).toBe(0); // disabled
        expect(mgr.selectLod(1000, 0, 0, 1, 0.1, true)).toBe(2);  // enabled
    });

    test('a level whose skinned-ness differs from the base throws', () => {
        const { mgr, single } = setup();
        single('staticBase', 20);
        single('skinnedLevel', 21, true, 0);
        expect(() => mgr.add({ prefab: 'staticBase', lod: [{ prefabId: 'skinnedLevel', distance: 10 }] } as never))
            .toThrow('skinned');
    });
});

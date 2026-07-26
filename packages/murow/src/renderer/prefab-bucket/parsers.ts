/**
 * Spec parsers — pure functions that turn a prefab spec into its parsed prefab.
 * Used by createPrefabBucket; not part of the public surface.
 */

import type { PrefabParserMap } from './index';
import { parseGltf } from '../gltf/parser';
import { parseSpritesheet } from '../spritesheet/parser';
import type {
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
} from './specs';

export const parsers3d: PrefabParserMap<Prefab3DSpec, Prefab3D> = {
    gltf: async (spec, ctx) => {
        if (spec.type !== 'gltf') throw new Error('gltf parser given non-gltf spec');

        // Spec semantics for `animations`:
        //   - omitted          → load all clips, animationList = discovered names
        //   - []               → load zero clips, no animationList (static skinned model)
        //   - ['Run', 'Idle']  → load only those, animationList = ['Run', 'Idle'] (literal)
        const parsed = await parseGltf(spec.src, {
            animations: spec.animations !== undefined ? [...spec.animations] : undefined,
            freezeAnimations: spec.freezeAnimations === true,
        });
        const skinnedPartCount = parsed.primitives.filter(p => p.skinned).length;
        const jointCount = parsed.skin?.data.jointCount ?? 0;
        let totalVertexCount = 0;
        for (const p of parsed.primitives) totalVertexCount += p.positions.length / 3;

        const base: any = {
            type: 'gltf',
            id: spec.id,
            parsed,
            skinnedPartCount,
            jointCount,
            totalVertexCount,
            metadata: spec.metadata ?? {},
            hitbox: spec.hitbox,
        };

        // Animation views — present only when the spec declared a non-empty list,
        // OR when the spec omitted animations (we use the GLB's actual clip names).
        const declared = spec.animations !== undefined
            ? [...spec.animations]
            : (parsed.skin?.animClips.map(c => c.name) ?? []);
        if (declared.length > 0) {
            const record: Record<string, string> = {};
            for (const name of declared) record[name] = name;
            base.animations = record;
            base.animationList = declared;
        }

        // Lazy animation methods are attached only when the spec didn't freeze.
        // They mutate `parsed.skin.animClips` + the prefab's surface views in
        // place (so captured references stay live) and emit `clips-changed`.
        if (spec.freezeAnimations !== true) {
            base.loadAnimations = async (names: readonly string[]): Promise<void> => {
                const skin = parsed.skin;
                const source = parsed.source;
                if (!skin || !source) {
                    throw new Error(`loadAnimations: prefab '${spec.id}' has no source — was the model skinned and not frozen?`);
                }
                const existing = new Set(skin.animClips.map(c => c.name));
                const added: string[] = [];
                for (const name of names) {
                    if (existing.has(name)) continue;
                    const clip = source.decodeAnimation(name);
                    if (clip) {
                        skin.animClips.push(clip);
                        existing.add(name);
                        added.push(name);
                    }
                }
                if (added.length > 0) {
                    if (!base.animationList) base.animationList = [];
                    if (!base.animations) base.animations = {};
                    const list = base.animationList as string[];
                    const record = base.animations as Record<string, string>;
                    for (const name of added) {
                        list.push(name);
                        record[name] = name;
                    }
                    ctx.events.emit('clips-changed', { prefabId: spec.id, added, removed: [] });
                }
            };

            base.unloadAnimations = (names: readonly string[]): void => {
                const skin = parsed.skin;
                if (!skin) return;
                const drop = new Set(names);
                const removed: string[] = [];
                skin.animClips = skin.animClips.filter(c => {
                    if (drop.has(c.name)) { removed.push(c.name); return false; }
                    return true;
                });
                if (removed.length > 0) {
                    const list = base.animationList as string[] | undefined;
                    if (list) {
                        for (let i = list.length - 1; i >= 0; i--) {
                            if (drop.has(list[i])) list.splice(i, 1);
                        }
                    }
                    const record = base.animations as Record<string, string> | undefined;
                    if (record) {
                        for (const name of removed) delete record[name];
                    }
                    ctx.events.emit('clips-changed', { prefabId: spec.id, added: [], removed });
                }
            };

            // Snapshot of the spec-declared clip set, used by resetAnimations.
            const initialNames = new Set(declared);
            base.resetAnimations = (): void => {
                const skin = parsed.skin;
                if (!skin) return;
                const toDrop: string[] = [];
                for (const c of skin.animClips) {
                    if (!initialNames.has(c.name)) toDrop.push(c.name);
                }
                if (toDrop.length > 0) base.unloadAnimations!(toDrop);
            };
        }

        return base;
    },
    grid: (spec) => {
        if (spec.type !== 'grid') throw new Error('grid parser given non-grid spec');
        return {
            type: 'grid',
            id: spec.id,
            size: spec.size,
            step: spec.step,
            lineWidth: spec.lineWidth,
            metadata: (spec.metadata ?? {}) as any,
            hitbox: spec.hitbox,
        };
    },
    cube: (spec) => {
        if (spec.type !== 'cube') throw new Error('cube parser given non-cube spec');
        return {
            type: 'cube',
            id: spec.id,
            size: spec.size ?? 1,
            metadata: (spec.metadata ?? {}) as any,
            hitbox: spec.hitbox,
        };
    },
    composite: (spec) => {
        if (spec.type !== 'composite') throw new Error('composite parser given non-composite spec');
        return {
            type: 'composite',
            id: spec.id,
            parts: spec.parts,
            metadata: (spec.metadata ?? {}) as any,
            hitbox: spec.hitbox,
        };
    },
    plane: (spec) => {
        if (spec.type !== 'plane') throw new Error('plane parser given non-plane spec');
        return {
            type: 'plane',
            id: spec.id,
            texture: spec.texture,
            width: spec.width ?? 1,
            height: spec.height ?? 1,
            metadata: (spec.metadata ?? {}) as any,
            hitbox: spec.hitbox,
        };
    }
};

export const parsers2d: PrefabParserMap<Prefab2DSpec, Prefab2D> = {
    spritesheet: async (spec, _ctx) => {
        if (spec.type !== 'spritesheet') throw new Error('spritesheet parser given non-spritesheet spec');
        const parsed = await parseSpritesheet({
            image: spec.src,
            frameWidth: spec.frameWidth,
            frameHeight: spec.frameHeight,
            data: spec.data,
        });
        return {
            type: 'spritesheet',
            id: spec.id,
            parsed,
            frameCount: parsed.uvs.length,
            width: parsed.width,
            height: parsed.height,
            metadata: (spec.metadata ?? {}) as any,
            hitbox: spec.hitbox,
        };
    },
};

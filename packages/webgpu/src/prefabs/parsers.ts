/**
 * Spec parsers — pure functions that turn a prefab spec into its parsed prefab.
 * Used by createPrefabBucket; not part of the public surface.
 */

import type { PrefabParserMap } from 'murow/renderer';
import { parseGltf } from '../3d/gltf-parser';
import { parseSpritesheet } from '../spritesheet/spritesheet-parser';
import type {
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
} from './specs';

export const parsers3d: PrefabParserMap<Prefab3DSpec, Prefab3D> = {
    gltf: async (spec) => {
        if (spec.type !== 'gltf') throw new Error('gltf parser given non-gltf spec');

        // Spec semantics for `animations`:
        //   - omitted          → load all clips, animationList = discovered names
        //   - []               → load zero clips, no animationList (static skinned model)
        //   - ['Run', 'Idle']  → load only those, animationList = ['Run', 'Idle'] (literal)
        const parsed = await parseGltf(
            spec.url,
            spec.animations !== undefined ? { animations: [...spec.animations] } : undefined,
        );
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
            metadata: spec.metadata,
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
            metadata: spec.metadata as any,
        };
    },
};

export const parsers2d: PrefabParserMap<Prefab2DSpec, Prefab2D> = {
    spritesheet: async (spec) => {
        if (spec.type !== 'spritesheet') throw new Error('spritesheet parser given non-spritesheet spec');
        const parsed = await parseSpritesheet({
            image: spec.url,
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
            metadata: spec.metadata as any,
        };
    },
};

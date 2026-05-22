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
        const parsed = await parseGltf(spec.url, spec.animations ? { animations: [...spec.animations] } : undefined);
        const skinnedPartCount = parsed.primitives.filter(p => p.skinned).length;
        const jointCount = parsed.skin?.data.jointCount ?? 0;
        let totalVertexCount = 0;
        for (const p of parsed.primitives) totalVertexCount += p.positions.length / 3;

        // Build both views over the animation set declared on the spec.
        // - `animations`: record keyed by name (for `prefab.animations.Run`)
        // - `animationList`: tuple of literals (for iteration / `rng.pick`)
        const declared = spec.animations ? [...spec.animations] : (parsed.skin?.animClips.map(c => c.name) ?? []);
        const animations: Record<string, string> = {};
        for (const name of declared) animations[name] = name;

        return {
            type: 'gltf',
            id: spec.id,
            parsed,
            animations: animations as any,
            animationList: declared as any,
            skinnedPartCount,
            jointCount,
            totalVertexCount,
        };
    },
    grid: (spec) => {
        if (spec.type !== 'grid') throw new Error('grid parser given non-grid spec');
        return {
            type: 'grid',
            id: spec.id,
            size: spec.size,
            step: spec.step,
            lineWidth: spec.lineWidth,
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
        };
    },
};

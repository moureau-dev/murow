import { d, std } from '../../../../shaders/typegpu';
import type { MaterialSpec } from '../materials/specs';

// Free variables injected into the fragment by the shader transpiler
// (`attachShaderMetadata`). Declared here only so TypeScript accepts them; they
// have no runtime binding and are resolved against the material externals.
declare const material: { cols: number; rows: number; life: number };
declare const textures: { atlas: any; atlasSampler: any };
declare const scene: { time: number };

export interface DecalMaterialOptions {
    /** Atlas texture id from the AssetBucket. */
    atlas: string;
    /** Atlas grid columns / rows. */
    cols: number;
    rows: number;
    /** Seconds a decal takes to fade out. Default 8. */
    life?: number;
}

/**
 * A decal material: an unlit, alpha-blended quad that samples one cell of an
 * atlas and fades out over `life`. Per-decal data arrives through the engine's
 * `vCustom` varying: `x` = atlas cell index, `y` = spawn time (seconds).
 */
export function decalMaterialSpec(opts: DecalMaterialOptions): MaterialSpec {
    return {
        type: 'shader',
        id: 'decal',
        lit: false,
        blend: 'alpha',
        depthWrite: false,
        cull: 'none',
        textures: { atlas: opts.atlas },
        uniforms: { cols: d.f32, rows: d.f32, life: d.f32 },
        defaultUniforms: { cols: opts.cols, rows: opts.rows, life: opts.life ?? 8 },
        shaders: {
            fragment: {
                fn: (input: { vUV: { x: number; y: number }; vCustom: { x: number; y: number } }) => {
                    const cell = input.vCustom.x;
                    const spawn = input.vCustom.y;
                    const col = std.mod(cell, material.cols);
                    const row = std.floor(cell / material.cols);
                    const uv = d.vec2f(
                        (col + input.vUV.x) / material.cols,
                        (row + input.vUV.y) / material.rows,
                    );
                    const tex = std.textureSample(textures.atlas, textures.atlasSampler, uv);
                    const age = scene.time - spawn;
                    const fade = 1.0 - std.saturate(age / material.life);
                    return d.vec4f(tex.x, tex.y, tex.z, tex.w * fade);
                },
            },
        },
    };
}

/**
 * Spritesheet parser — fetches an image (and optionally a texture-packer JSON)
 * and returns CPU-side data ready for GPU upload. Pure: no device, no GPU buffers.
 *
 * The renderer's `loadSpritesheet` is a thin wrapper that calls this then uploads.
 * Splitting parse from upload lets callers fetch all spritesheets in parallel
 * (via `Promise.all`) before a renderer exists.
 */
import type { SpriteUV } from 'murow/renderer/types';
import {
    computeGridUVs,
    computeTexturePackerUVs,
    loadImage,
    type TexturePackerData,
} from './spritesheet';
import type { SpritesheetSource } from 'murow/renderer/types';

/** CPU-side result of parsing a spritesheet source. */
export interface ParsedSpritesheet {
    bitmap: ImageBitmap;
    uvs: SpriteUV[];
    width: number;
    height: number;
}

/**
 * Parse a spritesheet source: fetch the image, decode it, and resolve UVs.
 * Does no GPU work. Safe to call in parallel; safe to call before a renderer exists.
 */
export async function parseSpritesheet(source: SpritesheetSource): Promise<ParsedSpritesheet> {
    const bitmap = await loadImage(source.image);

    let uvs: SpriteUV[];
    if (source.data) {
        const resp = await fetch(source.data);
        const json: TexturePackerData = await resp.json();
        uvs = computeTexturePackerUVs(json);
    } else if (source.frameWidth && source.frameHeight) {
        uvs = computeGridUVs(bitmap.width, bitmap.height, source.frameWidth, source.frameHeight);
    } else {
        uvs = [{ minX: 0, minY: 0, maxX: 1, maxY: 1 }];
    }

    return { bitmap, uvs, width: bitmap.width, height: bitmap.height };
}

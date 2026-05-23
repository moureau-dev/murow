/**
 * Pure spritesheet helpers — UV math and image loading.
 *
 * Renderer-agnostic. The actual GPU-bound `Spritesheet` class (with `GPUTexture` /
 * `GPUSampler`) lives in the webgpu package.
 */
import type { SpriteUV } from '../types';

export interface GridSpritesheetConfig {
    image: string;
    frameWidth: number;
    frameHeight: number;
}

export interface TexturePackerFrame {
    frame: { x: number; y: number; w: number; h: number };
}

export interface TexturePackerData {
    frames: Record<string, TexturePackerFrame>;
    meta: { size: { w: number; h: number } };
}

export interface SpritesheetConfig {
    image: string;
    frameWidth?: number;
    frameHeight?: number;
    data?: string;
}

export function computeGridUVs(
    imageWidth: number, imageHeight: number,
    frameWidth: number, frameHeight: number,
): SpriteUV[] {
    const cols = Math.floor(imageWidth / frameWidth);
    const rows = Math.floor(imageHeight / frameHeight);
    const uvs: SpriteUV[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            uvs.push({
                minX: (col * frameWidth) / imageWidth,
                minY: (row * frameHeight) / imageHeight,
                maxX: ((col + 1) * frameWidth) / imageWidth,
                maxY: ((row + 1) * frameHeight) / imageHeight,
            });
        }
    }
    return uvs;
}

export function computeTexturePackerUVs(data: TexturePackerData): SpriteUV[] {
    const { w, h } = data.meta.size;
    const uvs: SpriteUV[] = [];
    for (const key of Object.keys(data.frames)) {
        const frame = data.frames[key].frame;
        uvs.push({
            minX: frame.x / w,
            minY: frame.y / h,
            maxX: (frame.x + frame.w) / w,
            maxY: (frame.y + frame.h) / h,
        });
    }
    return uvs;
}

export async function loadImage(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    const blob = await response.blob();
    return createImageBitmap(blob);
}

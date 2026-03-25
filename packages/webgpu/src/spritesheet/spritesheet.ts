/**
 * Spritesheet — manages sprite UV coordinates and GPU texture.
 * Supports grid-based spritesheets and texture-packer JSON.
 *
 * Texture creation uses the raw GPUDevice (accessed via root.device)
 * since TypeGPU's texture API is unstable and we need copyExternalImageToTexture.
 */
import type { SpritesheetHandle, SpriteUV } from 'murow';

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

export class Spritesheet implements SpritesheetHandle {
    readonly id: number;
    readonly frameCount: number;
    readonly texture: GPUTexture;
    readonly textureView: GPUTextureView;
    readonly sampler: GPUSampler;

    private uvs: SpriteUV[];
    private _width: number;
    private _height: number;

    constructor(
        id: number,
        texture: GPUTexture,
        textureView: GPUTextureView,
        sampler: GPUSampler,
        uvs: SpriteUV[],
        width: number,
        height: number,
    ) {
        this.id = id;
        this.texture = texture;
        this.textureView = textureView;
        this.sampler = sampler;
        this.uvs = uvs;
        this.frameCount = uvs.length;
        this._width = width;
        this._height = height;
    }

    getUV(spriteIndex: number): SpriteUV {
        if (spriteIndex < 0 || spriteIndex >= this.frameCount) {
            throw new Error(`Sprite index ${spriteIndex} out of range [0, ${this.frameCount})`);
        }
        return this.uvs[spriteIndex];
    }

    get width(): number { return this._width; }
    get height(): number { return this._height; }
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

export function createTextureFromBitmap(
    device: GPUDevice,
    bitmap: ImageBitmap,
): { texture: GPUTexture; view: GPUTextureView } {
    const texture = device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
    );
    return { texture, view: texture.createView() };
}

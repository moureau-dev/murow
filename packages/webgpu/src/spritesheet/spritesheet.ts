/**
 * GPU-bound parts of spritesheet handling. Pure helpers (UV math, image loading)
 * live in `murow/renderer/spritesheet-helpers`; they're re-exported here for
 * backwards compatibility with code that did `import { ... } from 'murow/webgpu'`.
 *
 * Texture creation uses the raw GPUDevice (accessed via root.device)
 * since TypeGPU's texture API is unstable and we need copyExternalImageToTexture.
 */
import type { SpritesheetHandle, SpriteUV } from 'murow/renderer';

export {
    computeGridUVs,
    computeTexturePackerUVs,
    loadImage,
    type GridSpritesheetConfig,
    type SpritesheetConfig,
    type TexturePackerData,
    type TexturePackerFrame,
} from 'murow/renderer';

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

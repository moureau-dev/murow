import type { TexturePrefab } from 'murow/renderer';
import { createTextureFromBitmap } from '../../../spritesheet/spritesheet';

export interface GpuTexture {
    view: GPUTextureView;
    sampler: GPUSampler;
    bindGroup: GPUBindGroup;
}

/** Key of the 1×1 white fallback (never collides with user texture ids). */
const WHITE_ID = '';

/**
 * TextureRegistry — owns the uploaded textures and their bind groups. The
 * white fallback is registered so bind group 1 is always valid for instances
 * without a texture override or model default.
 */
export class TextureRegistry {
    private readonly byId = new Map<string, GpuTexture>();

    constructor(
        private readonly device: GPUDevice,
        private readonly layout: GPUBindGroupLayout,
    ) {}

    has(id: string): boolean {
        return this.byId.has(id);
    }

    get(id: string): GpuTexture | undefined {
        return this.byId.get(id);
    }

    /** Bind group of the white fallback. */
    get white(): GPUBindGroup {
        return this.byId.get(WHITE_ID)!.bindGroup;
    }

    initWhiteFallback(): void {
        const texture = this.device.createTexture({
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
            { texture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1],
        );
        const view = texture.createView();
        const sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        const bindGroup = this.createBindGroup(view, sampler);
        this.byId.set(WHITE_ID, { view, sampler, bindGroup });
    }

    async upload(prefab: TexturePrefab): Promise<void> {
        const bitmap = await createImageBitmap(prefab.parsed);
        const { view } = createTextureFromBitmap(this.device, bitmap);
        bitmap.close();
        const sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });
        this.byId.set(prefab.id, { view, sampler, bindGroup: this.createBindGroup(view, sampler) });
    }

    private createBindGroup(view: GPUTextureView, sampler: GPUSampler): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.layout,
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: sampler },
            ],
        });
    }
}

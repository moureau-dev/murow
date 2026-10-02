import type { TexturePrefab } from 'murow/renderer';
import { createTextureFromBitmap } from '../../../spritesheet/spritesheet';

export interface GpuTexture {
    view: GPUTextureView;
    sampler: GPUSampler;
    bindGroup: GPUBindGroup;
}

/**
 * TextureRegistry — owns the uploaded textures and their bind groups. Each
 * `TexturePrefab` is stamped with its integer `gpuIndex` at upload. The white
 * fallback is kept separately so bind group 1 is always valid.
 */
export class TextureRegistry {
    private readonly gpuTextures: GpuTexture[] = [];
    private whiteTex: GpuTexture | null = null;
    private resolve: ((id: string) => TexturePrefab | undefined) | null = null;

    constructor(
        private readonly device: GPUDevice,
        private readonly layout: GPUBindGroupLayout,
    ) {}

    /** Attach the id to prefab resolver once the asset bucket is available. */
    setResolver(resolve: (id: string) => TexturePrefab | undefined): void {
        this.resolve = resolve;
    }

    has(id: string): boolean {
        return this.resolve?.(id)?.gpuIndex !== undefined;
    }

    get(id: string): GpuTexture | undefined {
        const index = this.resolve?.(id)?.gpuIndex;
        return index === undefined ? undefined : this.gpuTextures[index];
    }

    /** Bind group of the white fallback. */
    get white(): GPUBindGroup {
        return this.whiteTex!.bindGroup;
    }

    /** The white fallback texture (view + sampler). */
    get whiteTexture(): GpuTexture {
        return this.whiteTex!;
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
        this.whiteTex = { view, sampler, bindGroup: this.createBindGroup(view, sampler) };
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
        prefab.gpuIndex = this.gpuTextures.length;
        this.gpuTextures.push({ view, sampler, bindGroup: this.createBindGroup(view, sampler) });
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

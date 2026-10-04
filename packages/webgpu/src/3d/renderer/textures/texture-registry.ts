import type { TexturePrefab } from 'murow/renderer';

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
        const width = bitmap.width;
        const height = bitmap.height;
        const levels = Math.max(1, Math.floor(Math.log2(Math.max(width, height))) + 1);
        const texture = this.device.createTexture({
            size: [width, height, 1],
            format: 'rgba8unorm',
            mipLevelCount: levels,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height]);
        bitmap.close();

        // WebGPU has no built-in mip blit; downsample on the CPU. Without a mip
        // chain, minified textures (small or distant surfaces) alias into moire.
        if (levels > 1 && typeof document !== 'undefined') {
            let source: CanvasImageSource = prefab.parsed as unknown as CanvasImageSource;
            let w = width;
            let h = height;
            for (let level = 1; level < levels; level++) {
                const nw = Math.max(1, w >> 1);
                const nh = Math.max(1, h >> 1);
                const canvas = document.createElement('canvas');
                canvas.width = nw;
                canvas.height = nh;
                const ctx = canvas.getContext('2d');
                if (!ctx) break;
                ctx.drawImage(source, 0, 0, nw, nh);
                const levelBitmap = await createImageBitmap(canvas);
                this.device.queue.copyExternalImageToTexture(
                    { source: levelBitmap },
                    { texture, mipLevel: level },
                    [nw, nh],
                );
                levelBitmap.close();
                source = canvas;
                w = nw;
                h = nh;
            }
        }

        const view = texture.createView();
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

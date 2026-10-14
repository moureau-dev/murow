/**
 * WebGPU implementation of the renderer's `Occlusion` port.
 *
 * Owns a hierarchical depth (HZB) pyramid and the culling compute kernels so the
 * renderer never sees a pipeline or a shader module. A non-compute backend would
 * implement the same port with a CPU test or a different technique.
 *
 * The kernels are authored with the `murow/gpu` DSL and compiled to WGSL by the
 * WGSL backend, so no target source lives here. The data path is zero per-frame
 * JS allocation: external raw buffers, encoded into the caller's encoder.
 */
import type {
    RawBindGroup,
    RawBuffer,
    RawCommandEncoder,
    RawComputePipeline,
    RawDevice,
    RawSampler,
    RawTexture,
    RawTextureView,
} from 'murow/gpu';
import { RawBufferUsage, RawTextureUsage } from 'murow/gpu';
import { GpuBindGroupLayout, GpuShader, type GpuCompiledShader } from 'murow/gpu';
import type { Occlusion, OcclusionBatch } from 'murow/renderer/managers/runtime';
import { compileProgram, createGpuBindGroupLayout, d } from '../gpu';
import {
    ARGS_STRIDE,
    BATCH_STRIDE,
    BUILD_WORKGROUP,
    CULL_LAYOUT,
    DOWN_LAYOUT,
    FROM_DEPTH_LAYOUT,
    RESET_LAYOUT,
    WORKGROUP,
    cullBody,
    hzbDownBody,
    hzbFromDepthBody,
    resetBody,
} from './occlusion-kernels';

/**
 * Resources the occlusion port is wired to.
 *
 * The renderer (renderer-3d) supplies these from the mesh pipelines it already
 * owns. Every buffer is borrowed and never destroyed by this port.
 */
export interface CreateOcclusionDeps {
    /** The frame depth texture (`depth24plus`, sampleable). Bound as `texture_depth_2d`. */
    readonly depthTexture: RawTexture;
    /**
     * Reserved nearest sampler for adjacent passes. The HZB kernels use
     * `textureLoad`, so the port does not bind it.
     */
    readonly depthSampler?: RawSampler;
    /** `DynamicMesh` storage buffer, one record per instance slot. */
    readonly dynamicBuffer: RawBuffer;
    /** `StaticMesh` storage buffer, one record per instance slot. */
    readonly staticBuffer: RawBuffer;
    /**
     * Per-model bounds, one `vec4<f32>` per model id. `xyz` are the model's
     * base half-extents; `w` is reserved. Uploaded by the model library.
     */
    readonly modelBounds: RawBuffer;
    /**
     * Uniform buffer whose first 64 bytes are the `mat4x4<f32>` view-projection
     * matrix. May be the head of the mesh uniform buffer.
     */
    readonly viewProjection: RawBuffer;
    /**
     * Per-slot visibility buffer for skinned instances. The cull clears the
     * slots it culls; the skinned vertex shader collapses a 0 slot. Borrowed.
     */
    readonly occlusionBuffer?: RawBuffer;
    /** Candidate slot capacity. Informational; `configure` owns the sizing. */
    readonly maxInstances: number;
    /** Batch capacity. Informational; `configure` owns the sizing. */
    readonly maxBatches: number;
}

/**
 * Build the renderer's `Occlusion` port backed by WebGPU compute.
 *
 * The returned port allocates the batch table and indirect args buffers in
 * {@link Occlusion.configure}, builds a two-level ping-pong HZB pyramid in
 * {@link Occlusion.buildPyramid}, and compacts visible candidates in place in
 * {@link Occlusion.cull}. Compaction writes into each batch's `outputOffset`
 * region of `candidateSlots`; the mesh VS reads it unchanged through
 * `slotIndices[instance_index]` because the indirect `firstInstance` is that
 * `outputOffset`.
 */
export function createOcclusion(root: { device: RawDevice }, deps: CreateOcclusionDeps): Occlusion {
    return new WebGpuOcclusion(root, deps);
}

class WebGpuOcclusion implements Occlusion {
    private readonly device: RawDevice;
    private readonly deps: CreateOcclusionDeps;

    private maxBatches = 0;
    private maxInstances = 0;

    private batchTable: RawBuffer | null = null;
    private args: RawBuffer | null = null;
    private frameParams: RawBuffer | null = null;
    private batchTableCPU = new Uint32Array(0);
    private frameParamsCPU = new Uint32Array(12);
    private readonly frameParamsF32 = new Float32Array(12);
    /** NDC depth margin before culling. Higher = less eager. Tunable at runtime. */
    bias = 0.005;

    private hzb: [RawTexture, RawTexture] | null = null;
    private hzbW0 = 0;
    private hzbH0 = 0;
    private mipCount = 0;
    private depthTextureRef: RawTexture;
    private depthW = 0;
    private depthH = 0;
    private builtChain = 0;
    private hasBuilt = false;

    private buildParams: RawBuffer[] = [];

    private fromDepthPipeline: RawComputePipeline | null = null;
    private downPipeline: RawComputePipeline | null = null;
    private cullPipeline: RawComputePipeline | null = null;
    private resetPipeline: RawComputePipeline | null = null;

    private fromDepthLayout: GPUBindGroupLayout | null = null;
    private downLayout: GPUBindGroupLayout | null = null;
    private cullLayout: GPUBindGroupLayout | null = null;
    private resetLayout: GPUBindGroupLayout | null = null;

    private fromDepthBG: [RawBindGroup, RawBindGroup] | null = null;
    private downBG: [RawBindGroup[], RawBindGroup[]] | null = null;
    private cullBG: [RawBindGroup, RawBindGroup] | null = null;
    private resetBG: RawBindGroup | null = null;

    private candidateSlots: RawBuffer | null = null;
    /** Buffers the current cull bind group points at (default: non-skinned). */
    private cullDynamic: RawBuffer | null = null;
    private cullStatic: RawBuffer | null = null;
    private cullVis: RawBuffer | null = null;
    private writeOcclusion = false;
    /** Non-skinned per-slot visibility (skinned lives on the renderer deps). */
    private staticVis: RawBuffer | null = null;
    private visOnes = new Uint32Array(0);

    constructor(root: { device: RawDevice }, deps: CreateOcclusionDeps) {
        this.device = root.device;
        this.deps = deps;
        this.depthTextureRef = deps.depthTexture;
    }

    get visibleSlots(): RawBuffer | null {
        return null;
    }

    get indirectArgs(): RawBuffer | null {
        return this.args;
    }

    configure(options: { maxBatches: number; maxInstances: number }): void {
        this.release();
        this.maxBatches = Math.max(1, options.maxBatches | 0);
        this.maxInstances = Math.max(1, options.maxInstances | 0);

        const device = this.device;
        this.batchTable = device.createBuffer({
            size: this.maxBatches * BATCH_STRIDE * 4,
            usage: RawBufferUsage.STORAGE | RawBufferUsage.COPY_DST,
        });
        this.args = device.createBuffer({
            // Per-batch draw args (5 u32), per-batch debug records (4 u32),
            // and four global debug values.
            size: (this.maxBatches * (ARGS_STRIDE + 4) + 4) * 4,
            usage: RawBufferUsage.STORAGE | RawBufferUsage.INDIRECT | RawBufferUsage.COPY_DST | RawBufferUsage.COPY_SRC,
        });
        this.frameParams = device.createBuffer({
            size: 48,
            usage: RawBufferUsage.UNIFORM | RawBufferUsage.COPY_DST,
        });
        this.batchTableCPU = new Uint32Array(this.maxBatches * BATCH_STRIDE);
        this.staticVis = device.createBuffer({
            size: this.maxInstances * 4,
            usage: RawBufferUsage.STORAGE | RawBufferUsage.COPY_DST | RawBufferUsage.COPY_SRC,
        });

        this.ensurePipelines();
        this.ensureHzb();
        this.resetBG = this.bindGroup(this.resetLayout!, [
            { binding: 0, resource: { buffer: this.batchTable } },
            { binding: 1, resource: { buffer: this.args } },
            { binding: 2, resource: { buffer: this.frameParams } },
        ]);
        if (this.candidateSlots) this.rebuildCullBG();
    }

    /** CPU readback of the per-slot visibility (1 = drawn, 0 = culled). */
    async readVisibility(): Promise<{ static: Uint32Array; skinned: Uint32Array }> {
        const [statics, skinned] = await Promise.all([
            this.readBuffer(this.staticVis),
            this.readBuffer(this.deps.occlusionBuffer ?? null),
        ]);
        return { static: statics, skinned };
    }

    /** Whether an instance handle is currently occluded (not drawn). */
    async isOccluded(handle: { slot: number; skinned?: boolean }): Promise<boolean> {
        const vis = await this.readVisibility();
        const arr = handle.skinned ? vis.skinned : vis.static;
        return arr[handle.slot >>> 0] === 0;
    }

    private async readBuffer(b: RawBuffer | null): Promise<Uint32Array> {
        if (!b) return new Uint32Array(0);
        const size = (b as any).size as number;
        const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(b, 0, staging, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const out = new Uint32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        staging.destroy();
        return out;
    }

    async readArgs(): Promise<Uint32Array> {
        const args = this.args;
        if (!args) return new Uint32Array(0);
        const staging = this.device.createBuffer({
            size: args.size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(args, 0, staging, 0, args.size);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const copy = new Uint32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        staging.destroy();
        return copy;
    }

    setDepth(texture: RawTexture): void {
        if (texture === this.depthTextureRef) return;
        this.depthTextureRef = texture;
        this.depthW = 0;
        this.depthH = 0;
    }

    buildPyramid(encoder: RawCommandEncoder): void {
        if (!this.hzb) return;
        this.ensureHzb();

        const write = 1 - this.builtChain;
        const pass = encoder.beginComputePass();
        const [w0, h0] = this.mipDims(0);
        pass.setPipeline(this.fromDepthPipeline!);
        pass.setBindGroup(0, this.fromDepthBG![write]);
        pass.dispatchWorkgroups(ceilDiv(w0, BUILD_WORKGROUP), ceilDiv(h0, BUILD_WORKGROUP));
        for (let mip = 1; mip < this.mipCount; mip++) {
            const [mw, mh] = this.mipDims(mip);
            pass.setPipeline(this.downPipeline!);
            pass.setBindGroup(0, this.downBG![write]![mip - 1]!);
            pass.dispatchWorkgroups(ceilDiv(mw, BUILD_WORKGROUP), ceilDiv(mh, BUILD_WORKGROUP));
        }
        pass.end();

        this.builtChain = write;
        this.hasBuilt = true;
    }

    cull(
        encoder: RawCommandEncoder,
        candidateSlots: RawBuffer,
        batches: readonly OcclusionBatch[],
        dynamicBuffer?: RawBuffer,
        staticBuffer?: RawBuffer,
        writeOcclusion = false,
    ): void {
        const count = batches.length;
        if (count === 0 || !this.args || !this.resetBG) return;

        // Reset to the default (non-skinned) buffers when none are passed, so the
        // static and skinned passes don't leave each other's bindings in place.
        let rebuild = candidateSlots !== this.candidateSlots;
        this.candidateSlots = candidateSlots;
        const dyn = dynamicBuffer ?? this.deps.dynamicBuffer;
        const st = staticBuffer ?? this.deps.staticBuffer;
        if (dyn !== this.cullDynamic) { this.cullDynamic = dyn; rebuild = true; }
        if (st !== this.cullStatic) { this.cullStatic = st; rebuild = true; }
        const vis = (writeOcclusion ? this.deps.occlusionBuffer : this.staticVis) ?? this.staticVis;
        if (vis !== this.cullVis) { this.cullVis = vis; rebuild = true; }
        if (rebuild) this.rebuildCullBG();
        if (!this.cullBG) return;
        this.writeOcclusion = writeOcclusion;

        // Reset every slot to visible; the cull clears the ones it rejects.
        if (vis) {
            const n = (((vis as any).size as number) / 4) | 0;
            if (this.visOnes.length < n) this.visOnes = new Uint32Array(n).fill(1);
            this.device.queue.writeBuffer(vis, 0, this.visOnes.subarray(0, n));
        }

        const table = this.batchTableCPU;
        let maxCandidates = 0;
        for (let i = 0; i < count; i++) {
            const batch = batches[i]!;
            const at = i * BATCH_STRIDE;
            table[at] = batch.modelId >>> 0;
            table[at + 1] = batch.candidateOffset >>> 0;
            table[at + 2] = batch.candidateCount >>> 0;
            table[at + 3] = batch.outputOffset >>> 0;
            table[at + 4] = batch.indexCount >>> 0;
            table[at + 5] = 0;
            table[at + 6] = 0;
            table[at + 7] = 0;
            if (batch.candidateCount > maxCandidates) maxCandidates = batch.candidateCount;
        }
        this.device.queue.writeBuffer(this.batchTable!, 0, table);

        const params = this.frameParamsCPU;
        params[0] = count >>> 0;
        params[1] = this.depthW >>> 0;
        params[2] = this.depthH >>> 0;
        params[3] = (this.hasBuilt ? this.mipCount : 0) >>> 0;
        params[4] = this.hzbW0 >>> 0;
        params[5] = this.hzbH0 >>> 0;
        params[6] = (this.maxBatches * ARGS_STRIDE) >>> 0;
        params[7] = (this.maxBatches * (ARGS_STRIDE + 4)) >>> 0;
        params[8] = this.writeOcclusion ? 1 : 0;
        this.frameParamsF32[9] = this.bias;
        params[10] = writeOcclusion ? 8 : 9;
        this.device.queue.writeBuffer(this.frameParams!, 0, params);

        const reset = encoder.beginComputePass();
        reset.setPipeline(this.resetPipeline!);
        reset.setBindGroup(0, this.resetBG);
        reset.dispatchWorkgroups(ceilDiv(count, WORKGROUP));
        reset.end();

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.cullPipeline!);
        pass.setBindGroup(0, this.cullBG[this.builtChain]);
        pass.dispatchWorkgroups(ceilDiv(maxCandidates, WORKGROUP), count);
        pass.end();
    }

    /** Write the per-model bounds into the buffer the cull binds. */
    writeModelBounds(data: Float32Array, count: number): void {
        this.device.queue.writeBuffer(this.deps.modelBounds, 0, data.subarray(0, count * 8));
    }

    destroy(): void {
        this.release();
    }

    // --- resources -----------------------------------------------------------------

    private ensurePipelines(): void {
        if (this.fromDepthPipeline) return;
        const fromDepth = this.pipeline('occlusion-hzb-from-depth', hzbFromDepthBody, FROM_DEPTH_LAYOUT, [BUILD_WORKGROUP, BUILD_WORKGROUP, 1]);
        const down = this.pipeline('occlusion-hzb-down', hzbDownBody, DOWN_LAYOUT, [BUILD_WORKGROUP, BUILD_WORKGROUP, 1]);
        const reset = this.pipeline('occlusion-reset', resetBody, RESET_LAYOUT, [WORKGROUP, 1, 1]);
        const cull = this.pipeline('occlusion-cull', cullBody, CULL_LAYOUT, [WORKGROUP, 1, 1]);
        this.fromDepthPipeline = fromDepth.pipeline;
        this.fromDepthLayout = fromDepth.layout;
        this.downPipeline = down.pipeline;
        this.downLayout = down.layout;
        this.resetPipeline = reset.pipeline;
        this.resetLayout = reset.layout;
        this.cullPipeline = cull.pipeline;
        this.cullLayout = cull.layout;
    }

    /** Compile a DSL compute body to WGSL and build its pipeline + bind group layout. */
    private pipeline(
        label: string,
        body: (input: any, bindings: any) => void,
        layout: GpuBindGroupLayout,
        workgroupSize: readonly [number, number, number],
    ): { pipeline: RawComputePipeline; layout: GPUBindGroupLayout } {
        const device = this.device;
        const shader = GpuShader.compute(
            {
                in: { globalId: d.builtin.globalInvocationId },
                workgroup: workgroupSize,
                bindings: { res: layout },
            },
            body,
        );
        const compiled: GpuCompiledShader = compileProgram([shader]);
        const rawLayout = createGpuBindGroupLayout(device as unknown as GPUDevice, layout.toDescriptor());
        const pipeline = device.createComputePipeline({
            label,
            layout: device.createPipelineLayout({ bindGroupLayouts: [rawLayout] }),
            compute: {
                module: device.createShaderModule({ code: compiled.code, label }),
                entryPoint: 'cs_main',
            },
        });
        return { pipeline, layout: rawLayout };
    }

    private ensureHzb(): void {
        const width = this.depthTextureRef.width;
        const height = this.depthTextureRef.height;
        if (this.hzb && width === this.depthW && height === this.depthH) return;

        // Rebuilding on resize: drop the old chain without destroying it, since a
        // previous frame's (async) submit may still reference it. The GPU reclaims it.
        this.releaseHzb(false);

        this.depthW = width;
        this.depthH = height;
        this.hzbW0 = Math.max(1, Math.ceil(width / 2));
        this.hzbH0 = Math.max(1, Math.ceil(height / 2));
        this.mipCount = Math.max(1, Math.floor(Math.log2(Math.max(this.hzbW0, this.hzbH0))) + 1);

        const device = this.device;
        const createChain = (): RawTexture =>
            device.createTexture({
                size: [this.hzbW0, this.hzbH0],
                mipLevelCount: this.mipCount,
                format: 'r32float',
                usage: RawTextureUsage.STORAGE_BINDING | RawTextureUsage.TEXTURE_BINDING,
            });
        this.hzb = [createChain(), createChain()];

        this.buildParams = new Array(this.mipCount);
        for (let mip = 0; mip < this.mipCount; mip++) {
            const buffer = device.createBuffer({ size: 16, usage: RawBufferUsage.UNIFORM | RawBufferUsage.COPY_DST });
            const data = new Uint32Array(4);
            const [dw, dh] = this.mipDims(mip);
            if (mip === 0) {
                data[0] = width;
                data[1] = height;
            } else {
                const [sw, sh] = this.mipDims(mip - 1);
                data[0] = sw;
                data[1] = sh;
            }
            data[2] = dw;
            data[3] = dh;
            device.queue.writeBuffer(buffer, 0, data);
            this.buildParams[mip] = buffer;
        }

        const depthView = this.depthTextureRef.createView({ dimension: '2d', aspect: 'depth-only' });
        this.fromDepthBG = [
            this.hzbBuildGroup(depthView, this.storageView(this.hzb[0], 0)),
            this.hzbBuildGroup(depthView, this.storageView(this.hzb[1], 0)),
        ];
        this.downBG = [
            this.buildDownGroups(0),
            this.buildDownGroups(1),
        ];

        this.builtChain = 0;
        this.hasBuilt = false;
        if (this.candidateSlots) this.rebuildCullBG();
    }

    private buildDownGroups(chain: number): RawBindGroup[] {
        const groups: RawBindGroup[] = [];
        for (let mip = 1; mip < this.mipCount; mip++) {
            groups.push(this.bindGroup(this.downLayout!, [
                { binding: 0, resource: this.storageView(this.hzb![chain], mip - 1) },
                { binding: 1, resource: this.storageView(this.hzb![chain], mip) },
                { binding: 2, resource: { buffer: this.buildParams[mip] } },
            ]));
        }
        return groups;
    }

    private hzbBuildGroup(depthView: RawTextureView, dst: RawTextureView): RawBindGroup {
        return this.bindGroup(this.fromDepthLayout!, [
            { binding: 0, resource: depthView },
            { binding: 1, resource: dst },
            { binding: 2, resource: { buffer: this.buildParams[0] } },
        ]);
    }

    private rebuildCullBG(): void {
        if (!this.hzb || !this.candidateSlots || !this.args || !this.batchTable || !this.frameParams) return;
        const group = (chain: number): RawBindGroup =>
            this.bindGroup(this.cullLayout!, [
                { binding: 0, resource: { buffer: this.candidateSlots } },
                { binding: 1, resource: { buffer: this.batchTable } },
                { binding: 2, resource: { buffer: this.cullDynamic ?? this.deps.dynamicBuffer } },
                { binding: 3, resource: { buffer: this.cullStatic ?? this.deps.staticBuffer } },
                { binding: 4, resource: { buffer: this.deps.modelBounds } },
                { binding: 5, resource: { buffer: this.deps.viewProjection } },
                { binding: 6, resource: this.sampledView(this.hzb[chain]) },
                { binding: 7, resource: { buffer: this.args } },
                { binding: 8, resource: { buffer: this.frameParams } },
                { binding: 9, resource: { buffer: this.cullVis ?? this.staticVis ?? this.deps.occlusionBuffer ?? this.frameParams } },
            ]);
        this.cullBG = [group(0), group(1)];
    }

    private bindGroup(
        layout: GPUBindGroupLayout,
        entries: Array<{ binding: number; resource: unknown }>,
    ): RawBindGroup {
        return this.device.createBindGroup({ layout, entries }) as unknown as RawBindGroup;
    }

    private storageView(texture: RawTexture, mip: number): RawTextureView {
        return texture.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1 });
    }

    private sampledView(texture: RawTexture): RawTextureView {
        return texture.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: this.mipCount });
    }

    private mipDims(mip: number): [number, number] {
        const divisor = 2 ** mip;
        return [Math.max(1, Math.floor(this.hzbW0 / divisor)), Math.max(1, Math.floor(this.hzbH0 / divisor))];
    }

    private releaseHzb(destroy = true): void {
        if (this.hzb) {
            if (destroy) { this.hzb[0].destroy(); this.hzb[1].destroy(); }
            this.hzb = null;
        }
        if (destroy) for (const buffer of this.buildParams) buffer.destroy();
        this.buildParams = [];
        this.fromDepthBG = null;
        this.downBG = null;
        this.cullBG = null;
    }

    private release(): void {
        this.releaseHzb();
        this.batchTable?.destroy();
        this.args?.destroy();
        this.frameParams?.destroy();
        this.staticVis?.destroy();
        this.batchTable = null;
        this.args = null;
        this.frameParams = null;
        this.staticVis = null;
        this.cullVis = null;
        this.resetBG = null;
        this.candidateSlots = null;
    }
}

function ceilDiv(value: number, divisor: number): number {
    return Math.ceil(value / divisor);
}

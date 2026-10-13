/**
 * WebGPU implementation of the renderer's `Occlusion` port.
 *
 * Owns a hierarchical depth (HZB) pyramid and the culling compute kernels so the
 * renderer never sees a pipeline or a WGSL module. A non-compute backend would
 * implement the same port with a CPU test or a different technique.
 *
 * This is the only place a depth texture is read by compute. The kernels touch
 * resources the builder cannot express (depth texture loads, storage texture
 * writes, indirect args), so they are hand-written WGSL pipelines rather than
 * `ComputeBuilder` kernels. The data path is otherwise the same: zero per-frame
 * JS allocation, external raw buffers, encoded into the caller's encoder.
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
import type { Occlusion, OcclusionBatch } from 'murow/renderer/managers/runtime';

/** Invocations per workgroup for the cull and reset kernels. */
const WORKGROUP = 64;
/** Side of the square workgroup used by the HZB build kernels. */
const BUILD_WORKGROUP = 16;
/** u32 slots per batch record in the batch table. */
const BATCH_STRIDE = 8;
/** u32 slots per `drawIndexedIndirect` args record. */
const ARGS_STRIDE = 5;
/** Occupancy bias added to the tile max before the depth test. */
const DEPTH_BIAS = 1e-4;

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
    private frameParamsCPU = new Uint32Array(4);

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

    private fromDepthBG: [RawBindGroup, RawBindGroup] | null = null;
    private downBG: [RawBindGroup[], RawBindGroup[]] | null = null;
    private cullBG: [RawBindGroup, RawBindGroup] | null = null;
    private resetBG: RawBindGroup | null = null;

    private candidateSlots: RawBuffer | null = null;

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
            size: this.maxBatches * ARGS_STRIDE * 4,
            usage: RawBufferUsage.STORAGE | RawBufferUsage.INDIRECT | RawBufferUsage.COPY_DST | RawBufferUsage.COPY_SRC,
        });
        this.frameParams = device.createBuffer({
            size: 16,
            usage: RawBufferUsage.UNIFORM | RawBufferUsage.COPY_DST,
        });
        this.batchTableCPU = new Uint32Array(this.maxBatches * BATCH_STRIDE);

        this.ensurePipelines();
        this.ensureHzb();
        this.resetBG = this.bindGroup(this.resetPipeline!, [
            { binding: 0, resource: { buffer: this.batchTable } },
            { binding: 1, resource: { buffer: this.args } },
            { binding: 2, resource: { buffer: this.frameParams } },
        ]);
        if (this.candidateSlots) this.rebuildCullBG();
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

    cull(encoder: RawCommandEncoder, candidateSlots: RawBuffer, batches: readonly OcclusionBatch[]): void {
        const count = batches.length;
        if (count === 0 || !this.args || !this.resetBG) return;

        if (candidateSlots !== this.candidateSlots) {
            this.candidateSlots = candidateSlots;
            this.rebuildCullBG();
        }
        if (!this.cullBG) return;

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

    destroy(): void {
        this.release();
    }

    // --- resources -----------------------------------------------------------------

    private ensurePipelines(): void {
        if (this.fromDepthPipeline) return;
        const device = this.device;
        const module = (code: string, label: string) => device.createShaderModule({ code, label });
        const pipeline = (code: string, label: string): RawComputePipeline =>
            device.createComputePipeline({
                label,
                layout: 'auto',
                compute: { module: module(code, label), entryPoint: 'cs_main' },
            });

        this.fromDepthPipeline = pipeline(HZB_FROM_DEPTH_WGSL, 'occlusion-hzb-from-depth');
        this.downPipeline = pipeline(HZB_DOWN_WGSL, 'occlusion-hzb-down');
        this.cullPipeline = pipeline(CULL_WGSL, 'occlusion-cull');
        this.resetPipeline = pipeline(RESET_WGSL, 'occlusion-reset');
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
                format: 'rgba16float',
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
            groups.push(this.bindGroup(this.downPipeline!, [
                { binding: 0, resource: this.storageView(this.hzb![chain], mip - 1) },
                { binding: 1, resource: this.storageView(this.hzb![chain], mip) },
                { binding: 2, resource: { buffer: this.buildParams[mip] } },
            ]));
        }
        return groups;
    }

    private hzbBuildGroup(depthView: RawTextureView, dst: RawTextureView): RawBindGroup {
        return this.bindGroup(this.fromDepthPipeline!, [
            { binding: 0, resource: depthView },
            { binding: 1, resource: dst },
            { binding: 2, resource: { buffer: this.buildParams[0] } },
        ]);
    }

    private rebuildCullBG(): void {
        if (!this.hzb || !this.candidateSlots || !this.args || !this.batchTable || !this.frameParams) return;
        const group = (chain: number): RawBindGroup =>
            this.bindGroup(this.cullPipeline!, [
                { binding: 0, resource: { buffer: this.candidateSlots } },
                { binding: 1, resource: { buffer: this.batchTable } },
                { binding: 2, resource: { buffer: this.deps.dynamicBuffer } },
                { binding: 3, resource: { buffer: this.deps.staticBuffer } },
                { binding: 4, resource: { buffer: this.deps.modelBounds } },
                { binding: 5, resource: { buffer: this.deps.viewProjection } },
                { binding: 6, resource: this.sampledView(this.hzb[chain]) },
                { binding: 7, resource: { buffer: this.args } },
                { binding: 8, resource: { buffer: this.frameParams } },
            ]);
        this.cullBG = [group(0), group(1)];
    }

    private bindGroup(
        pipeline: RawComputePipeline,
        entries: Array<{ binding: number; resource: unknown }>,
    ): RawBindGroup {
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries,
        });
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
        this.batchTable = null;
        this.args = null;
        this.frameParams = null;
        this.resetBG = null;
        this.candidateSlots = null;
    }
}

function ceilDiv(value: number, divisor: number): number {
    return Math.ceil(value / divisor);
}

/** Build a mip 0 HZB tile from a `2x2` block of the frame depth texture. */
const HZB_FROM_DEPTH_WGSL = /* wgsl */ `
struct HzParams {
    srcW: u32,
    srcH: u32,
    dstW: u32,
    dstH: u32,
};

@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: HzParams;

@compute @workgroup_size(${BUILD_WORKGROUP}, ${BUILD_WORKGROUP}, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.dstW || gid.y >= params.dstH) { return; }
    let ix = gid.x * 2u;
    let iy = gid.y * 2u;
    let x0 = min(ix, params.srcW - 1u);
    let x1 = min(ix + 1u, params.srcW - 1u);
    let y0 = min(iy, params.srcH - 1u);
    let y1 = min(iy + 1u, params.srcH - 1u);
    let d0 = textureLoad(depthTex, vec2<i32>(i32(x0), i32(y0)), 0);
    let d1 = textureLoad(depthTex, vec2<i32>(i32(x1), i32(y0)), 0);
    let d2 = textureLoad(depthTex, vec2<i32>(i32(x0), i32(y1)), 0);
    let d3 = textureLoad(depthTex, vec2<i32>(i32(x1), i32(y1)), 0);
    let m = max(max(d0, d1), max(d2, d3));
    textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(m, 0.0, 0.0, 1.0));
}
`;

/** Reduce a mip by taking the max of each `2x2` block of the previous mip. */
const HZB_DOWN_WGSL = /* wgsl */ `
struct HzParams {
    srcW: u32,
    srcH: u32,
    dstW: u32,
    dstH: u32,
};

@group(0) @binding(0) var src: texture_storage_2d<rgba16float, read>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: HzParams;

@compute @workgroup_size(${BUILD_WORKGROUP}, ${BUILD_WORKGROUP}, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.dstW || gid.y >= params.dstH) { return; }
    let ix = gid.x * 2u;
    let iy = gid.y * 2u;
    let x0 = min(ix, params.srcW - 1u);
    let x1 = min(ix + 1u, params.srcW - 1u);
    let y0 = min(iy, params.srcH - 1u);
    let y1 = min(iy + 1u, params.srcH - 1u);
    let d0 = textureLoad(src, vec2<i32>(i32(x0), i32(y0))).r;
    let d1 = textureLoad(src, vec2<i32>(i32(x1), i32(y0))).r;
    let d2 = textureLoad(src, vec2<i32>(i32(x0), i32(y1))).r;
    let d3 = textureLoad(src, vec2<i32>(i32(x1), i32(y1))).r;
    let m = max(max(d0, d1), max(d2, d3));
    textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(m, 0.0, 0.0, 1.0));
}
`;

/** Reset each batch's indirect args and its instance counter before culling. */
const RESET_WGSL = /* wgsl */ `
struct FrameParams {
    numBatches: u32,
    screenW: u32,
    screenH: u32,
    mipCount: u32,
};

@group(0) @binding(0) var<storage, read> batches: array<u32>;
@group(0) @binding(1) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: FrameParams;

@compute @workgroup_size(${WORKGROUP}, 1, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let b = gid.x;
    if (b >= params.numBatches) { return; }
    let base = b * ${BATCH_STRIDE}u;
    let indexCount = batches[base + 4u];
    let outputOffset = batches[base + 3u];
    let a = b * ${ARGS_STRIDE}u;
    atomicStore(&args[a + 0u], indexCount);
    atomicStore(&args[a + 1u], 0u);
    atomicStore(&args[a + 2u], 0u);
    atomicStore(&args[a + 3u], 0u);
    atomicStore(&args[a + 4u], outputOffset);
}
`;

/**
 * Per (batch, candidate) occlusion test.
 *
 * Proactively conservative: it culls only when the AABB's nearest projected
 * depth is farther than the farthest depth in every HZB tile the AABB covers.
 * Visible candidates are compacted into the batch's `outputOffset` region and
 * the batch's instance count is incremented through the indirect args atomic.
 */
const CULL_WGSL = /* wgsl */ `
struct DynamicMesh {
    prevPosX: f32, prevPosY: f32, prevPosZ: f32,
    currPosX: f32, currPosY: f32, currPosZ: f32,
    prevRotX: f32, prevRotY: f32, prevRotZ: f32,
    currRotX: f32, currRotY: f32, currRotZ: f32,
    morph: f32,
};

struct StaticMesh {
    scaleX: f32, scaleY: f32, scaleZ: f32,
    colorR: f32, colorG: f32, colorB: f32,
    materialId: f32, custom0: f32, custom1: f32,
};

struct FrameParams {
    numBatches: u32,
    screenW: u32,
    screenH: u32,
    mipCount: u32,
};

@group(0) @binding(0) var<storage, read_write> slots: array<u32>;
@group(0) @binding(1) var<storage, read> batches: array<u32>;
@group(0) @binding(2) var<storage, read> dynamic: array<DynamicMesh>;
@group(0) @binding(3) var<storage, read> statics: array<StaticMesh>;
@group(0) @binding(4) var<storage, read> modelBounds: array<vec4<f32>>;
@group(0) @binding(5) var<uniform> viewProjection: mat4x4<f32>;
@group(0) @binding(6) var hzb: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(8) var<uniform> params: FrameParams;

fn emitSlot(slot: u32, batch: u32, outputOffset: u32) {
    let write = atomicAdd(&args[batch * ${ARGS_STRIDE}u + 1u], 1u);
    slots[outputOffset + write] = slot;
}

@compute @workgroup_size(${WORKGROUP}, 1, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let b = gid.y;
    if (b >= params.numBatches) { return; }
    let base = b * ${BATCH_STRIDE}u;
    let modelId = batches[base + 0u];
    let candidateOffset = batches[base + 1u];
    let candidateCount = batches[base + 2u];
    let outputOffset = batches[base + 3u];
    let ci = gid.x;
    if (ci >= candidateCount) { return; }

    let slot = slots[candidateOffset + ci];
    let d = dynamic[slot];
    let s = statics[slot];
    let center = vec3<f32>(d.currPosX, d.currPosY, d.currPosZ);
    let halfExtents = vec3<f32>(s.scaleX, s.scaleY, s.scaleZ) * modelBounds[modelId].xyz;

    if (params.mipCount == 0u) {
        emitSlot(slot, b, outputOffset);
        return;
    }

    var behind = false;
    var nearest = 1.0e30;
    var minX = 1.0e30;
    var minY = 1.0e30;
    var maxX = -1.0e30;
    var maxY = -1.0e30;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let sx = select(-1.0, 1.0, (i & 1u) != 0u);
        let sy = select(-1.0, 1.0, (i & 2u) != 0u);
        let sz = select(-1.0, 1.0, (i & 4u) != 0u);
        let world = center + vec3<f32>(sx, sy, sz) * halfExtents;
        let clip = viewProjection * vec4<f32>(world, 1.0);
        if (clip.w <= 0.0) { behind = true; }
        let ndc = clip.xyz / clip.w;
        nearest = min(nearest, ndc.z);
        let px = (ndc.x * 0.5 + 0.5) * f32(params.screenW);
        let py = (1.0 - (ndc.y * 0.5 + 0.5)) * f32(params.screenH);
        minX = min(minX, px);
        maxX = max(maxX, px);
        minY = min(minY, py);
        maxY = max(maxY, py);
    }

    if (behind) {
        emitSlot(slot, b, outputOffset);
        return;
    }
    if (maxX < 0.0 || maxY < 0.0 || minX > f32(params.screenW) || minY > f32(params.screenH)) {
        return;
    }

    let extent = max(maxX - minX, maxY - minY);
    var mip = 0u;
    if (extent > 1.0) {
        mip = u32(max(0.0, ceil(log2(extent)) - 1.0));
    }
    mip = min(mip, params.mipCount - 1u);

    let tile = f32(1u << (mip + 1u));
    let tx0 = i32(floor(max(minX, 0.0) / tile));
    let ty0 = i32(floor(max(minY, 0.0) / tile));
    let tx1 = i32(floor(min(maxX, f32(params.screenW) - 1.0) / tile));
    let ty1 = i32(floor(min(maxY, f32(params.screenH) - 1.0) / tile));

    var tileMax = 0.0;
    for (var ty = ty0; ty <= ty1; ty = ty + 1) {
        for (var tx = tx0; tx <= tx1; tx = tx + 1) {
            let v = textureLoad(hzb, vec2<i32>(tx, ty), i32(mip)).r;
            tileMax = max(tileMax, v);
        }
    }

    if (nearest > tileMax + ${DEPTH_BIAS}) { return; }
    emitSlot(slot, b, outputOffset);
}
`;

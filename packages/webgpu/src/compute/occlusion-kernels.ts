// @ts-nocheck
/**
 * Occlusion compute kernels, authored with the `murow/gpu` DSL.
 *
 * Kernel bodies are parsed from their source and compiled to WGSL by the WGSL
 * backend, so they are typed loosely: the DSL's value types are an authoring
 * fiction for the common shader surface, while these kernels do raw u32 index
 * math. The parser validates the real structure at compile time.
 */
import { GpuBindGroupLayout } from 'murow/gpu';
import { DynamicMesh, MeshUniforms, StaticMesh } from 'murow/renderer/managers/runtime';
import { d, std } from '../gpu';

/** Invocations per workgroup for the cull and reset kernels. */
export const WORKGROUP = 64;
/** Side of the square workgroup used by the HZB build kernels. */
export const BUILD_WORKGROUP = 16;
/** u32 slots per batch record in the batch table. */
export const BATCH_STRIDE = 8;
/** u32 slots per `drawIndexedIndirect` args record. */
export const ARGS_STRIDE = 5;

/** Uniform params for the HZB build kernels. */
export const HzParams = d.struct({ srcW: d.u32, srcH: d.u32, dstW: d.u32, dstH: d.u32 });
/** Uniform params shared by the reset and cull kernels. */
export const FrameParams = d.struct({
    numBatches: d.u32,
    screenW: d.u32,
    screenH: d.u32,
    mipCount: d.u32,
    hzbW0: d.u32,
    hzbH0: d.u32,
    /** u32 index in the args buffer where per-batch debug records start. */
    debugBase: d.u32,
    /** u32 index in the args buffer where the 4 global debug values start. */
    globalsBase: d.u32,
    /** 1 to write the per-slot occlusion visibility, 0 to skip (non-skinned). */
    writeOcclusion: d.u32,
});

/** Depth source plus the mip 0 storage target. */
export const FROM_DEPTH_LAYOUT = new GpuBindGroupLayout({
    depth: { depthTexture: true },
    dst: { storageTexture: { format: 'r32float', access: 'write' } },
    params: { uniform: HzParams },
});
/** One mip of the pyramid read, the next written. */
export const DOWN_LAYOUT = new GpuBindGroupLayout({
    src: { storageTexture: { format: 'r32float', access: 'read' } },
    dst: { storageTexture: { format: 'r32float', access: 'write' } },
    params: { uniform: HzParams },
});
/** Batch table, indirect args, and frame params. */
export const RESET_LAYOUT = new GpuBindGroupLayout({
    batches: { storage: d.arrayOf(d.u32, 1) },
    args: { storage: d.arrayOf(d.atomic(d.u32), 1), readwrite: true },
    params: { uniform: FrameParams },
});
/** Everything the per-candidate occlusion test reads. */
export const CULL_LAYOUT = new GpuBindGroupLayout({
    slots: { storage: d.arrayOf(d.u32, 1), readwrite: true },
    batches: { storage: d.arrayOf(d.u32, 1) },
    dynamic: { storage: d.arrayOf(DynamicMesh, 1) },
    statics: { storage: d.arrayOf(StaticMesh, 1) },
    modelBounds: { storage: d.arrayOf(d.vec4f, 1) },
    vp: { uniform: MeshUniforms },
    hzb: { texture: 'unfilterable-float' },
    args: { storage: d.arrayOf(d.atomic(d.u32), 1), readwrite: true },
    params: { uniform: FrameParams },
    /** Per-slot visibility for skinned instances (written only when enabled). */
    occlusion: { storage: d.arrayOf(d.u32, 1), readwrite: true },
});

/** Build a mip 0 HZB tile from a `2x2` block of the frame depth texture. */
export const hzbFromDepthBody = ({ globalId }, { res }) => {
    const p = res.params;
    if (globalId.x >= p.dstW || globalId.y >= p.dstH) { return; }
    const ix = globalId.x * d.u32(2);
    const iy = globalId.y * d.u32(2);
    const x0 = std.min(ix, p.srcW - d.u32(1));
    const x1 = std.min(ix + d.u32(1), p.srcW - d.u32(1));
    const y0 = std.min(iy, p.srcH - d.u32(1));
    const y1 = std.min(iy + d.u32(1), p.srcH - d.u32(1));
    const d0 = std.textureLoad(res.depth, d.vec2i(d.i32(x0), d.i32(y0)), d.i32(0));
    const d1 = std.textureLoad(res.depth, d.vec2i(d.i32(x1), d.i32(y0)), d.i32(0));
    const d2 = std.textureLoad(res.depth, d.vec2i(d.i32(x0), d.i32(y1)), d.i32(0));
    const d3 = std.textureLoad(res.depth, d.vec2i(d.i32(x1), d.i32(y1)), d.i32(0));
    const m = std.max(std.max(d0, d1), std.max(d2, d3));
    std.textureStore(res.dst, d.vec2i(d.i32(globalId.x), d.i32(globalId.y)), d.vec4f(m, 0, 0, 1));
};

/** Reduce a mip by taking the max of each `2x2` block of the previous mip. */
export const hzbDownBody = ({ globalId }, { res }) => {
    const p = res.params;
    if (globalId.x >= p.dstW || globalId.y >= p.dstH) { return; }
    const ix = globalId.x * d.u32(2);
    const iy = globalId.y * d.u32(2);
    const x0 = std.min(ix, p.srcW - d.u32(1));
    const x1 = std.min(ix + d.u32(1), p.srcW - d.u32(1));
    const y0 = std.min(iy, p.srcH - d.u32(1));
    const y1 = std.min(iy + d.u32(1), p.srcH - d.u32(1));
    const d0 = std.textureLoad(res.src, d.vec2i(d.i32(x0), d.i32(y0))).r;
    const d1 = std.textureLoad(res.src, d.vec2i(d.i32(x1), d.i32(y0))).r;
    const d2 = std.textureLoad(res.src, d.vec2i(d.i32(x0), d.i32(y1))).r;
    const d3 = std.textureLoad(res.src, d.vec2i(d.i32(x1), d.i32(y1))).r;
    const m = std.max(std.max(d0, d1), std.max(d2, d3));
    std.textureStore(res.dst, d.vec2i(d.i32(globalId.x), d.i32(globalId.y)), d.vec4f(m, 0, 0, 1));
};

/** Reset each batch's indirect args and its instance counter before culling. */
export const resetBody = ({ globalId }, { res }) => {
    const b = globalId.x;
    if (b >= res.params.numBatches) { return; }
    const base = b * d.u32(8); /* BATCH_STRIDE */
    const indexCount = res.batches[base + d.u32(4)];
    const outputOffset = res.batches[base + d.u32(3)];
    if (res.params.writeOcclusion == d.u32(0)) {
        const a = b * d.u32(5); /* ARGS_STRIDE */
        std.atomicStore(res.args[a + d.u32(0)], indexCount);
        std.atomicStore(res.args[a + d.u32(1)], d.u32(0));
        std.atomicStore(res.args[a + d.u32(2)], d.u32(0));
        std.atomicStore(res.args[a + d.u32(3)], d.u32(0));
        std.atomicStore(res.args[a + d.u32(4)], outputOffset);
    }
    // Zero this batch's debug record (nearest, tileMax, mip, reason).
    const dbg = res.params.debugBase + b * d.u32(4);
    std.atomicStore(res.args[dbg + d.u32(0)], d.u32(0));
    std.atomicStore(res.args[dbg + d.u32(1)], d.u32(0));
    std.atomicStore(res.args[dbg + d.u32(2)], d.u32(0));
    std.atomicStore(res.args[dbg + d.u32(3)], d.u32(0));
    if (b == d.u32(0)) {
        const g = res.params.globalsBase;
        std.atomicStore(res.args[g + d.u32(0)], res.params.screenW);
        std.atomicStore(res.args[g + d.u32(1)], res.params.screenH);
        std.atomicStore(res.args[g + d.u32(2)], res.params.hzbW0);
        std.atomicStore(res.args[g + d.u32(3)], res.params.mipCount);
    }
};

/**
 * Per (batch, candidate) occlusion test.
 *
 * Proactively conservative: it culls only when the AABB's nearest projected
 * depth is farther than the farthest depth in every HZB tile the AABB covers.
 * Visible candidates are compacted into the batch's `outputOffset` region and
 * the batch's instance count is incremented through the indirect args atomic.
 */
export const cullBody = ({ globalId }, { res }) => {
    const params = res.params;
    const b = globalId.y;
    if (b >= params.numBatches) { return; }
    const base = b * d.u32(8); /* BATCH_STRIDE */
    const modelId = res.batches[base + d.u32(0)];
    const candidateOffset = res.batches[base + d.u32(1)];
    const candidateCount = res.batches[base + d.u32(2)];
    const outputOffset = res.batches[base + d.u32(3)];
    const ci = globalId.x;
    if (ci >= candidateCount) { return; }

    const slot = res.slots[candidateOffset + ci];
    if (params.writeOcclusion == d.u32(1)) { res.occlusion[slot] = d.u32(1); }
    const dm = res.dynamic[slot];
    const sm = res.statics[slot];
    // modelBounds holds two vec4 per model: [2*id] = half extents, [2*id+1] = center offset.
    const halfExtents = d.vec3f(sm.scaleX, sm.scaleY, sm.scaleZ) * res.modelBounds[modelId * d.u32(2)].xyz;
    const center = d.vec3f(dm.currPosX, dm.currPosY, dm.currPosZ)
        + d.vec3f(sm.scaleX, sm.scaleY, sm.scaleZ) * res.modelBounds[modelId * d.u32(2) + d.u32(1)].xyz;

    if (params.mipCount == d.u32(0)) {
        if (params.writeOcclusion == d.u32(0)) { const w = std.atomicAdd(res.args[b * d.u32(5) + d.u32(1)], d.u32(1)); res.slots[outputOffset + w] = slot; }
        return;
    }

    let behind = false;
    let nearest = d.f32(1e30);
    let minX = d.f32(1e30);
    let minY = d.f32(1e30);
    let maxX = d.f32(-1e30);
    let maxY = d.f32(-1e30);
    for (let i = d.u32(0); i < d.u32(8); i = i + d.u32(1)) {
        const sx = std.select(d.f32(-1), d.f32(1), (i & d.u32(1)) != d.u32(0));
        const sy = std.select(d.f32(-1), d.f32(1), (i & d.u32(2)) != d.u32(0));
        const sz = std.select(d.f32(-1), d.f32(1), (i & d.u32(4)) != d.u32(0));
        const world = center + d.vec3f(sx, sy, sz) * halfExtents;
        const clip = res.vp.viewProjection * d.vec4f(world, d.f32(1));
        if (clip.w <= d.f32(0)) { behind = true; }
        const ndc = clip.xyz / clip.w;
        nearest = std.min(nearest, ndc.z);
        const px = (ndc.x * d.f32(0.5) + d.f32(0.5)) * d.f32(params.screenW);
        const py = (d.f32(1) - (ndc.y * d.f32(0.5) + d.f32(0.5))) * d.f32(params.screenH);
        minX = std.min(minX, px);
        maxX = std.max(maxX, px);
        minY = std.min(minY, py);
        maxY = std.max(maxY, py);
    }

    if (behind) {
        if (params.writeOcclusion == d.u32(0)) { const w = std.atomicAdd(res.args[b * d.u32(5) + d.u32(1)], d.u32(1)); res.slots[outputOffset + w] = slot; }
        return;
    }
    // No off-screen reject here: the frustum pass already culls off-screen
    // instances, and rejecting on the projected AABB was dropping large,
    // on-screen objects whose projection did not match the pass's bounds.

    const extent = std.max(maxX - minX, maxY - minY);
    let mip = d.u32(0);
    if (extent > d.f32(1)) {
        // Sample a mip finer than the object's own size so the object spans
        // several tiles: culling then requires the occluder to cover the whole
        // footprint, instead of a single oversized tile.
        mip = d.u32(std.max(d.f32(0), std.ceil(std.log2(extent)) - d.f32(3)));
    }
    mip = std.min(mip, params.mipCount - d.u32(1));

    const tile = d.f32(d.u32(1) << (mip + d.u32(1)));
    const tx0 = d.i32(std.floor(std.max(minX, d.f32(0)) / tile));
    const ty0 = d.i32(std.floor(std.max(minY, d.f32(0)) / tile));
    const tx1 = d.i32(std.floor(std.min(maxX, d.f32(params.screenW) - d.f32(1)) / tile));
    const ty1 = d.i32(std.floor(std.min(maxY, d.f32(params.screenH) - d.f32(1)) / tile));

    // Clamp to the mip's texel dimensions: out-of-range loads return 0, which
    // would under-estimate the tile max and wrongly cull large objects.
    const mw = std.max(d.u32(1), params.hzbW0 >> mip);
    const mh = std.max(d.u32(1), params.hzbH0 >> mip);
    const txHi = std.min(tx1, d.i32(mw) - d.i32(1));
    const tyHi = std.min(ty1, d.i32(mh) - d.i32(1));
    if (txHi < tx0 || tyHi < ty0) {
        if (params.writeOcclusion == d.u32(0)) { const w = std.atomicAdd(res.args[b * d.u32(5) + d.u32(1)], d.u32(1)); res.slots[outputOffset + w] = slot; }
        return;
    }

    let tileMax = d.f32(0);
    for (let ty = ty0; ty <= tyHi; ty = ty + 1) {
        for (let tx = tx0; tx <= txHi; tx = tx + 1) {
            const v = std.textureLoad(res.hzb, d.vec2i(tx, ty), d.i32(mip)).r;
            tileMax = std.max(tileMax, v);
            // Also sample the parent tile: it covers a superset of the child's
            // area, so this is conservative and damps flicker as the extent
            // crosses a mip boundary.
            if (mip + d.u32(1) < params.mipCount) {
                const pt = std.textureLoad(res.hzb, d.vec2i(tx / 2, ty / 2), d.i32(mip + d.u32(1))).r;
                tileMax = std.max(tileMax, pt);
            }
        }
    }

    if (nearest > tileMax + d.f32(0.002)) {
        // reason 2: culled by the depth test (record nearest / tileMax / mip)
        if (params.writeOcclusion == d.u32(1)) { res.occlusion[slot] = d.u32(0); }
        const db = params.debugBase + b * d.u32(4);
        std.atomicStore(res.args[db + d.u32(0)], d.u32(std.max(d.f32(0), nearest) * d.f32(10000.0)));
        std.atomicStore(res.args[db + d.u32(1)], d.u32(tileMax * d.f32(10000.0)));
        std.atomicStore(res.args[db + d.u32(2)], modelId);
        std.atomicStore(res.args[db + d.u32(3)], d.u32(2));
        return;
    }
    if (params.writeOcclusion == d.u32(0)) { const w = std.atomicAdd(res.args[b * d.u32(5) + d.u32(1)], d.u32(1)); res.slots[outputOffset + w] = slot; }
};
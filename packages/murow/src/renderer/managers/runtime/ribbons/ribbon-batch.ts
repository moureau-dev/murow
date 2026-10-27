import type {
    RawBindGroup,
    RawBindGroupLayout,
    RawBlendState,
    RawBuffer,
    RawColorTargetState,
    RawDevice,
    RawRenderPassEncoder,
    RawPipelineLayout,
    RawRenderPipeline,
    RawShaderModule,
    RawTexture,
    RawTextureFormat,
    RawTextureView,
    RawVertexBufferLayout,
} from 'murow/gpu';
import {
    GpuBindGroupLayout,
    GpuShader,
    RawBufferUsage,
    RawTextureUsage,
} from 'murow/gpu';
import { d, std } from '../gpu-ns';
import type { Logger } from 'murow/core';
import type { RibbonBlend, RibbonColor, RibbonFacing, RibbonGradient, RibbonWidth } from './types';
import type { RendererRuntime } from '../backend';

const VERTEX_FLOATS = 9;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const INDICES_PER_SEGMENT = 6;

const FrameUniforms = d.struct({
    viewProj: d.mat4x4f,
});

const RibbonBindings = new GpuBindGroupLayout({
    frame: { uniform: FrameUniforms },
    tex: { texture: 'float' },
    sampler: { sampler: 'filtering' },
});

interface DrawRange {
    texture: string | null;
    blend: RibbonBlend;
    depthTest: boolean;
    first: number;
    count: number;
    sortKey: number;
}

export interface RibbonBatchDeps {
    readonly runtime: RendererRuntime;
    readonly device: RawDevice;
    readonly format: RawTextureFormat;
    readonly maxVertices: number;
    readonly logger: Logger;
    readonly resolveTexture?: (id: string) => RawTextureView | undefined;
}

export interface AppendStripOptions {
    width: RibbonWidth;
    color: RibbonColor | RibbonGradient;
    texture?: string | null;
    blend?: RibbonBlend;
    depthTest?: boolean;
    facing?: RibbonFacing;
    closed?: boolean;
    uvScale?: number;
    uvOffset?: number;
    alphas?: ArrayLike<number> | null;
    layer?: number;
}

/**
 * Shared CPU geometry builder and GPU pass for lines, ribbons, trails, and
 * beams. Managers append world-space strips each view; the batch uploads one
 * vertex/index buffer and draws depth-sorted ranges.
 */
export class RibbonBatch {
    private readonly runtime: RendererRuntime;
    private readonly device: RawDevice;
    private readonly format: RawTextureFormat;
    private readonly logger: Logger;
    private readonly resolveTexture?: (id: string) => RawTextureView | undefined;

    private readonly maxVertices: number;
    private readonly maxIndices: number;

    private readonly vertices: Float32Array;
    private readonly indices: Uint32Array;
    private vertexCount = 0;
    private indexCount = 0;

    private readonly frameData = new Float32Array(16);
    private readonly frameBuffer: RawBuffer;
    private readonly vertexBuffer: RawBuffer;
    private readonly indexBuffer: RawBuffer;

    private readonly bindGroupLayout: RawBindGroupLayout;
    private readonly pipelineLayout: RawPipelineLayout;
    private readonly alphaDepthPipeline: RawRenderPipeline;
    private readonly additiveDepthPipeline: RawRenderPipeline;
    private readonly alphaNoDepthPipeline: RawRenderPipeline;
    private readonly additiveNoDepthPipeline: RawRenderPipeline;

    private readonly whiteTexture: RawTexture;
    private readonly whiteView: RawTextureView;
    private readonly sampler: ReturnType<RawDevice['createSampler']>;
    private readonly whiteBindGroup: RawBindGroup;
    private readonly textureBindGroups = new Map<string, RawBindGroup>();

    private readonly ranges: DrawRange[];
    private rangeCount = 0;

    private cameraX = 0;
    private cameraY = 0;
    private cameraZ = 0;
    private rightX = 1; private rightY = 0; private rightZ = 0;
    private upX = 0; private upY = 1; private upZ = 0;
    private layerMask = 0xffffffff;

    /** Number of strips that did not fit in this frame's vertex budget. */
    dropped = 0;

    constructor(deps: RibbonBatchDeps) {
        this.runtime = deps.runtime;
        this.device = deps.device;
        this.format = deps.format;
        this.logger = deps.logger;
        this.resolveTexture = deps.resolveTexture;
        this.maxVertices = Math.max(2, deps.maxVertices | 0);
        this.maxIndices = this.maxVertices * 3;

        this.vertices = new Float32Array(this.maxVertices * VERTEX_FLOATS);
        this.indices = new Uint32Array(this.maxIndices);
        this.ranges = new Array(Math.max(1, this.maxVertices >> 1));

        const vertexBufferLayout: RawVertexBufferLayout = {
            arrayStride: VERTEX_BYTES,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x2' },
                { shaderLocation: 2, offset: 20, format: 'float32x4' },
            ],
        };

        this.frameBuffer = this.runtime.createRawBuffer(FrameUniforms, 'uniform');
        this.vertexBuffer = this.device.createBuffer({
            size: this.maxVertices * VERTEX_BYTES,
            usage: RawBufferUsage.VERTEX | RawBufferUsage.COPY_DST,
        });
        this.indexBuffer = this.device.createBuffer({
            size: this.maxIndices * 4,
            usage: RawBufferUsage.INDEX | RawBufferUsage.COPY_DST,
        });

        this.bindGroupLayout = this.runtime.createBindGroupLayout(RibbonBindings.toDescriptor());
        this.pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

        const vertexShader = GpuShader.vertex({
            in: {
                position: d.location(0, d.vec3f),
                uv: d.location(1, d.vec2f),
                color: d.location(2, d.vec4f),
            },
            out: {
                pos: d.builtin.position,
                vUV: d.vec2f,
                vColor: d.vec4f,
            },
            bindings: { ribbon: RibbonBindings },
        }, (input, { ribbon }) => {
            return {
                pos: std.mul(ribbon.frame.viewProj, d.vec4f(input.position.x, input.position.y, input.position.z, 1.0)),
                vUV: input.uv,
                vColor: input.color,
            };
        });

        const fragment = GpuShader.fragment({
            in: { vUV: d.vec2f, vColor: d.vec4f },
            out: d.vec4f,
            bindings: { ribbon: RibbonBindings },
        }, (input, { ribbon }) => {
            const tex = std.textureSample(ribbon.tex, ribbon.sampler, input.vUV);
            return d.vec4f(
                std.mul(input.vColor.x, tex.x),
                std.mul(input.vColor.y, tex.y),
                std.mul(input.vColor.z, tex.z),
                std.mul(input.vColor.w, tex.w),
            );
        });

        let code: string;
        try {
            ({ code } = this.runtime.compile([vertexShader, fragment]));
        } catch (error) {
            throw new Error(`ribbon shader compile failed: ${(error as Error).message}`);
        }
        const module = this.device.createShaderModule({ code, label: 'ribbons' });

        const alphaTarget = this.target({
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        });
        const additiveTarget = this.target({
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        });

        const vertexState = { module, buffers: [vertexBufferLayout] };
        const layout = this.pipelineLayout;
        this.alphaDepthPipeline = this.pipeline(module, layout, vertexState, alphaTarget, true);
        this.additiveDepthPipeline = this.pipeline(module, layout, vertexState, additiveTarget, true);
        this.alphaNoDepthPipeline = this.pipeline(module, layout, vertexState, alphaTarget, false);
        this.additiveNoDepthPipeline = this.pipeline(module, layout, vertexState, additiveTarget, false);

        this.whiteTexture = this.device.createTexture({
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: RawTextureUsage.TEXTURE_BINDING | RawTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
            { texture: this.whiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1],
        );
        this.whiteView = this.whiteTexture.createView();
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });
        this.whiteBindGroup = this.bindGroup(this.whiteView);
    }

    /** Start a new view. Clears previous CPU geometry and captures camera state. */
    begin(
        viewProj: Float32Array,
        cameraPosition: ArrayLike<number>,
        right: ArrayLike<number>,
        up: ArrayLike<number>,
        alpha: number,
        layerMask = 0xffffffff,
    ): void {
        this.vertexCount = 0;
        this.indexCount = 0;
        this.rangeCount = 0;
        this.dropped = 0;
        this.frameData.set(viewProj, 0);
        this.cameraX = cameraPosition[0] ?? 0;
        this.cameraY = cameraPosition[1] ?? 0;
        this.cameraZ = cameraPosition[2] ?? 0;
        this.rightX = right[0] ?? 1; this.rightY = right[1] ?? 0; this.rightZ = right[2] ?? 0;
        this.upX = up[0] ?? 0; this.upY = up[1] ?? 1; this.upZ = up[2] ?? 0;
        this.layerMask = layerMask;
    }

    /**
     * Append one world-space strip. `points` is flat xyz. Returns false when
     * the strip does not fit in the frame's vertex or index budget.
     */
    appendStrip(points: ArrayLike<number>, pointCount: number, opts: AppendStripOptions): boolean {
        if (pointCount < 2) return false;
        if (((opts.layer ?? 1) & this.layerMask) === 0) return true;
        const closed = opts.closed === true;
        const count = closed ? pointCount + 1 : pointCount;
        const neededVertices = count * 2;
        const neededIndices = (count - 1) * INDICES_PER_SEGMENT;
        if (this.vertexCount + neededVertices > this.maxVertices || this.indexCount + neededIndices > this.maxIndices) {
            this.dropped++;
            return false;
        }

        const vertexBase = this.vertexCount;
        const indexBase = this.indexCount;
        const texture = opts.texture ?? null;
        const blend = opts.blend ?? 'alpha';
        const depthTest = opts.depthTest !== false;
        const facing = opts.facing ?? 'camera';
        const uvScale = opts.uvScale ?? 1;
        const uvOffset = opts.uvOffset ?? 0;
        const width = opts.width;
        const widthStart = typeof width === 'number' ? width : width[0];
        const widthEnd = typeof width === 'number' ? width : width[1];
        const color = opts.color;
        const start = isGradient(color) ? color[0] : color;
        const end = isGradient(color) ? color[1] : color;
        const alphas = opts.alphas ?? null;
        const verts = this.vertices;
        const idx = this.indices;

        let depthSum = 0;
        for (let i = 0; i < count; i++) {
            const src = closed ? (i % pointCount) : i;
            const prev = closed
                ? ((i - 1 + pointCount) % pointCount)
                : Math.max(0, i - 1);
            const next = closed
                ? ((i + 1) % pointCount)
                : Math.min(pointCount - 1, i + 1);

            const px = points[src * 3]!;
            const py = points[src * 3 + 1]!;
            const pz = points[src * 3 + 2]!;
            const ax = points[prev * 3]!;
            const ay = points[prev * 3 + 1]!;
            const az = points[prev * 3 + 2]!;
            const bx = points[next * 3]!;
            const by = points[next * 3 + 1]!;
            const bz = points[next * 3 + 2]!;

            let tx = bx - ax;
            let ty = by - ay;
            let tz = bz - az;
            const tlen = Math.hypot(tx, ty, tz);
            if (tlen < 1e-8) {
                tx = 1; ty = 0; tz = 0;
            } else {
                tx /= tlen; ty /= tlen; tz /= tlen;
            }

            let sx: number;
            let sy: number;
            let sz: number;
            if (facing === 'up') {
                sx = ty * 0 - tz * 1;
                sy = tz * 0 - tx * 0;
                sz = tx * 1 - ty * 0;
            } else {
                const vx = this.cameraX - px;
                const vy = this.cameraY - py;
                const vz = this.cameraZ - pz;
                sx = ty * vz - tz * vy;
                sy = tz * vx - tx * vz;
                sz = tx * vy - ty * vx;
            }
            let slen = Math.hypot(sx, sy, sz);
            if (slen < 1e-8) {
                sx = this.rightX; sy = this.rightY; sz = this.rightZ;
                slen = Math.hypot(sx, sy, sz) || 1;
            }
            sx /= slen; sy /= slen; sz /= slen;

            const t = count > 1 ? i / (count - 1) : 0;
            const half = (widthStart + (widthEnd - widthStart) * t) * 0.5;
            const cr = start[0] + (end[0] - start[0]) * t;
            const cg = start[1] + (end[1] - start[1]) * t;
            const cb = start[2] + (end[2] - start[2]) * t;
            const ca = (start[3] + (end[3] - start[3]) * t) * (alphas?.[src] ?? 1);
            const u = t * uvScale + uvOffset;
            const v0 = 0;
            const v1 = 1;

            const out = vertexBase * VERTEX_FLOATS + i * 2 * VERTEX_FLOATS;
            verts[out] = px + sx * half;
            verts[out + 1] = py + sy * half;
            verts[out + 2] = pz + sz * half;
            verts[out + 3] = u;
            verts[out + 4] = v0;
            verts[out + 5] = cr;
            verts[out + 6] = cg;
            verts[out + 7] = cb;
            verts[out + 8] = ca;
            verts[out + 9] = px - sx * half;
            verts[out + 10] = py - sy * half;
            verts[out + 11] = pz - sz * half;
            verts[out + 12] = u;
            verts[out + 13] = v1;
            verts[out + 14] = cr;
            verts[out + 15] = cg;
            verts[out + 16] = cb;
            verts[out + 17] = ca;

            const dx = px - this.cameraX;
            const dy = py - this.cameraY;
            const dz = pz - this.cameraZ;
            depthSum += dx * dx + dy * dy + dz * dz;
        }

        for (let i = 0; i < count - 1; i++) {
            const a = vertexBase + i * 2;
            const b = a + 1;
            const c = a + 2;
            const e = a + 3;
            const o = indexBase + i * INDICES_PER_SEGMENT;
            idx[o] = a;
            idx[o + 1] = b;
            idx[o + 2] = c;
            idx[o + 3] = b;
            idx[o + 4] = e;
            idx[o + 5] = c;
        }

        this.vertexCount += neededVertices;
        this.indexCount += neededIndices;
        const sortKey = -(depthSum / count);
        this.pushRange(texture, blend, depthTest, indexBase, neededIndices, sortKey);
        return true;
    }

    /** Upload and draw every appended range into the current pass. */
    end(pass: RawRenderPassEncoder): void {
        if (this.indexCount === 0) return;
        this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
        this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertices.subarray(0, this.vertexCount * VERTEX_FLOATS));
        this.device.queue.writeBuffer(this.indexBuffer, 0, this.indices.subarray(0, this.indexCount));

        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.setIndexBuffer(this.indexBuffer, 'uint32');

        // Far to near. Additive is order-independent, alpha is not.
        for (let i = 1; i < this.rangeCount; i++) {
            const item = this.ranges[i]!;
            let j = i - 1;
            while (j >= 0 && this.ranges[j]!.sortKey > item.sortKey) {
                this.ranges[j + 1] = this.ranges[j]!;
                j--;
            }
            this.ranges[j + 1] = item;
        }

        let pipeline: RawRenderPipeline | null = null;
        let bindGroup: RawBindGroup | null = null;
        for (let i = 0; i < this.rangeCount; i++) {
            const range = this.ranges[i]!;
            const nextPipeline = this.pipelineFor(range.blend, range.depthTest);
            if (nextPipeline !== pipeline) {
                pass.setPipeline(nextPipeline);
                pipeline = nextPipeline;
            }
            const nextBind = this.bindGroupFor(range.texture);
            if (nextBind !== bindGroup) {
                pass.setBindGroup(0, nextBind);
                bindGroup = nextBind;
            }
            pass.drawIndexed(range.count, 1, range.first, 0);
        }

        if (this.dropped > 0) {
            this.logger.warn('ribbon vertex budget exceeded; strips were dropped', {
                dropped: this.dropped,
                maxVertices: this.maxVertices,
            });
        }
    }

    get vertexCapacity(): number { return this.maxVertices; }
    get vertexUsage(): number { return this.vertexCount; }
    get indexUsage(): number { return this.indexCount; }
    get stripCount(): number { return this.rangeCount; }

    destroy(): void {
        this.vertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.frameBuffer.destroy();
        this.whiteTexture.destroy();
        this.textureBindGroups.clear();
    }

    private pushRange(texture: string | null, blend: RibbonBlend, depthTest: boolean, first: number, count: number, sortKey: number): void {
        let range = this.ranges[this.rangeCount];
        if (range === undefined) {
            range = { texture: null, blend: 'alpha', depthTest: true, first: 0, count: 0, sortKey: 0 };
            this.ranges[this.rangeCount] = range;
        }
        range.texture = texture;
        range.blend = blend;
        range.depthTest = depthTest;
        range.first = first;
        range.count = count;
        range.sortKey = sortKey;
        this.rangeCount++;
    }

    private pipelineFor(blend: RibbonBlend, depthTest: boolean): RawRenderPipeline {
        if (blend === 'additive') return depthTest ? this.additiveDepthPipeline : this.additiveNoDepthPipeline;
        return depthTest ? this.alphaDepthPipeline : this.alphaNoDepthPipeline;
    }

    private bindGroupFor(texture: string | null): RawBindGroup {
        if (texture === null || texture === '') return this.whiteBindGroup;
        const cached = this.textureBindGroups.get(texture);
        if (cached !== undefined) return cached;
        const view = this.resolveTexture?.(texture);
        if (view === undefined) return this.whiteBindGroup;
        const bg = this.bindGroup(view);
        this.textureBindGroups.set(texture, bg);
        return bg;
    }

    private bindGroup(view: RawTextureView): RawBindGroup {
        return this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.frameBuffer } },
                { binding: 1, resource: view },
                { binding: 2, resource: this.sampler },
            ],
        });
    }

    private target(blend: RawBlendState): RawColorTargetState {
        return { format: this.format, blend };
    }

    private pipeline(
        module: RawShaderModule,
        layout: RawPipelineLayout,
        vertex: { module: RawShaderModule; buffers: RawVertexBufferLayout[] },
        target: RawColorTargetState,
        depthTest: boolean,
    ): RawRenderPipeline {
        return this.device.createRenderPipeline({
            label: `ribbons-${depthTest ? 'depth' : 'nodepth'}`,
            layout,
            vertex,
            fragment: { module, targets: [target] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: depthTest ? 'less' : 'always',
            },
        });
    }
}

function isGradient(color: RibbonColor | RibbonGradient): color is RibbonGradient {
    return Array.isArray(color[0]);
}

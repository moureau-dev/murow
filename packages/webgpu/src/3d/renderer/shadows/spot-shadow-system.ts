import type { TgpuRoot } from 'typegpu';
import { tgpu, d } from '../../../shaders/typegpu';
import { DynamicMesh, StaticMesh } from '../../../core/types';
import { ShadowUniforms, createShadowVertex, createShadowFragment } from './shadow-system';
import type { ShadowDrawBatch, ShadowModelLike } from './shadow-system';

/** Fixed number of spot lights that can cast a shadow in a frame. */
export const MAX_SPOT_SHADOWS = 4;

/** Per-light perspective matrices + tunables, read by receiving materials. */
export const SpotShadowUniforms = d.struct({
    matrices: d.arrayOf(d.mat4x4f, MAX_SPOT_SHADOWS),
    /** x = active caster count, y = bias, z/w unused. */
    params: d.vec4f,
});

export interface SpotShadowSystemDeps {
    root: TgpuRoot;
    dynamicBuffer: GPUBuffer;
    staticBuffer: GPUBuffer;
    maxInstances: number;
}

/** Per-frame pose of a shadow-casting spot light. */
export interface SpotLightInput {
    px: number; py: number; pz: number;
    dx: number; dy: number; dz: number;
    /** Cone half-angle (radians). */
    angle: number;
    range: number;
}

const FLOATS = 16 * MAX_SPOT_SHADOWS + 4;

/**
 * Spot-light shadow maps. Renders casters into a `texture_2d_array` (one
 * perspective depth layer per casting spot, up to `MAX_SPOT_SHADOWS`), and
 * exposes the matrices + map for lit materials to PCF-sample per light.
 */
export class SpotShadowSystem {
    private readonly root: TgpuRoot;
    private readonly device: GPUDevice;
    private readonly maxInstances: number;
    private readonly slotIndexBuffer: GPUBuffer;
    private readonly sampler: GPUSampler;
    private readonly uniformBuffer: GPUBuffer;
    private readonly uniformData = new Float32Array(FLOATS);
    private readonly layout: ReturnType<typeof createSpotLayout>;
    private readonly pipeline: GPURenderPipeline;
    private readonly passBuffers: GPUBuffer[] = [];
    private readonly passBindGroups: GPUBindGroup[] = [];
    private readonly passData = new Float32Array(24);
    private readonly layerViews: GPUTextureView[] = [];
    private readonly depthLayerViews: GPUTextureView[] = [];
    private map: GPUTexture;
    private depth: GPUTexture;
    private readonly mapView: GPUTextureView;

    /** Max shadow distance / resolution. */
    resolution = 1024;
    bias = 0.002;
    enabled = true;

    constructor(deps: SpotShadowSystemDeps) {
        this.root = deps.root;
        this.device = deps.root.device;
        this.maxInstances = deps.maxInstances;
        this.slotIndexBuffer = this.device.createBuffer({
            size: Math.max(4, deps.maxInstances * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

        const targets = this.createTargets(this.resolution);
        this.map = targets.map;
        this.depth = targets.depth;
        this.mapView = targets.mapView;

        this.uniformBuffer = this.device.createBuffer({ size: FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        this.layout = createSpotLayout(deps.maxInstances);
        const vertex = createShadowVertex(this.layout as never);
        const fragment = createShadowFragment();
        const { code } = tgpu.resolveWithContext([vertex, fragment]);
        const module = this.device.createShaderModule({ code, label: 'spot-shadow' });
        const bgl = this.root.unwrap(this.layout) as unknown as GPUBindGroupLayout;
        this.pipeline = this.device.createRenderPipeline({
            label: 'spot-shadow',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            vertex: {
                module,
                buffers: [{
                    arrayStride: 32,
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },
                        { shaderLocation: 2, offset: 24, format: 'float32x2' },
                    ],
                }],
            },
            fragment: { module, targets: [{ format: 'rgba16float' }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        });

        for (let i = 0; i < MAX_SPOT_SHADOWS; i++) {
            const buf = this.device.createBuffer({ size: this.passData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.passBuffers.push(buf);
            this.passBindGroups.push(this.device.createBindGroup({
                layout: bgl,
                entries: [
                    { binding: 0, resource: { buffer: buf } },
                    { binding: 1, resource: { buffer: deps.dynamicBuffer } },
                    { binding: 2, resource: { buffer: deps.staticBuffer } },
                    { binding: 3, resource: { buffer: this.slotIndexBuffer } },
                ],
            }));
        }
    }

    get mapTexture(): GPUTextureView { return this.mapView; }
    get mapSampler(): GPUSampler { return this.sampler; }
    get uniforms(): GPUBuffer { return this.uniformBuffer; }

    setSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        if (count > 0) this.device.queue.writeBuffer(this.slotIndexBuffer, 0, slots, 0, count);
    }

    /** Render up to `MAX_SPOT_SHADOWS` casting spot lights into their layers. */
    render(encoder: GPUCommandEncoder, batches: ShadowDrawBatch[], getModel: (id: number) => ShadowModelLike | undefined, spots: readonly SpotLightInput[]): void {
        const count = this.enabled ? Math.min(spots.length, MAX_SPOT_SHADOWS) : 0;
        const m = this.uniformData;
        for (let i = 0; i < count; i++) {
            const s = spots[i]!;
            perspectiveLookAt(m, i * 16, s.px, s.py, s.pz, s.dx, s.dy, s.dz, Math.max(0.05, s.angle * 2), 0.05, Math.max(s.range, 0.1));
            // pass uniform: viewProjection + alpha(=1)
            for (let k = 0; k < 16; k++) this.passData[k] = m[i * 16 + k]!;
            this.passData[16] = 1; this.passData[17] = 0; this.passData[18] = 0; this.passData[19] = 0;
            this.passData[20] = 0; this.passData[21] = 0; this.passData[22] = 0; this.passData[23] = 0;
            this.device.queue.writeBuffer(this.passBuffers[i]!, 0, this.passData);

            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: this.layerViews[i]!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
                depthStencilAttachment: { view: this.depthLayerViews[i]!, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1.0 },
            });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.passBindGroups[i]!);
            let current: GPUBuffer | null = null;
            for (const batch of batches) {
                const model = getModel(batch.modelId);
                if (!model) continue;
                if (model.rawVertexBuffer !== current) { pass.setVertexBuffer(0, model.rawVertexBuffer); current = model.rawVertexBuffer; }
                if (model.rawIndexBuffer) {
                    pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                    pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                } else {
                    pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                }
            }
            pass.end();
        }
        m[MAX_SPOT_SHADOWS * 16] = count;
        m[MAX_SPOT_SHADOWS * 16 + 1] = this.bias;
        m[MAX_SPOT_SHADOWS * 16 + 2] = 1 / this.resolution;
        m[MAX_SPOT_SHADOWS * 16 + 3] = 0;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, m);
    }

    destroy(): void {
        this.map.destroy();
        this.depth.destroy();
        this.uniformBuffer.destroy();
        this.slotIndexBuffer.destroy();
        for (const b of this.passBuffers) b.destroy();
    }

    private createTargets(res: number): { map: GPUTexture; mapView: GPUTextureView; depth: GPUTexture } {
        const map = this.device.createTexture({ size: [res, res, MAX_SPOT_SHADOWS], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        const depth = this.device.createTexture({ size: [res, res, MAX_SPOT_SHADOWS], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
        this.layerViews.length = 0;
        this.depthLayerViews.length = 0;
        for (let i = 0; i < MAX_SPOT_SHADOWS; i++) {
            this.layerViews.push(map.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
            this.depthLayerViews.push(depth.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
        }
        return { map, mapView: map.createView({ dimension: '2d-array' }), depth };
    }
}

function createSpotLayout(maxInstances: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: ShadowUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(StaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
    });
}

/** `proj * view` for a spot light (column-major, WebGPU depth). */
function perspectiveLookAt(
    out: Float32Array, off: number,
    ex: number, ey: number, ez: number,
    dx: number, dy: number, dz: number,
    fov: number, near: number, far: number,
): void {
    let len = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(fy) > 0.99) { ux = 1; uy = 0; uz = 0; }
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux2 = ry * fz - rz * fy, uy2 = rz * fx - rx * fz, uz2 = rx * fy - ry * fx;
    const zx = -fx, zy = -fy, zz = -fz;
    // view (column-major)
    out[off + 0] = rx; out[off + 4] = ry; out[off + 8] = rz; out[off + 12] = -(rx * ex + ry * ey + rz * ez);
    out[off + 1] = ux2; out[off + 5] = uy2; out[off + 9] = uz2; out[off + 13] = -(ux2 * ex + uy2 * ey + uz2 * ez);
    out[off + 2] = zx; out[off + 6] = zy; out[off + 10] = zz; out[off + 14] = -(zx * ex + zy * ey + zz * ez);
    out[off + 3] = 0; out[off + 7] = 0; out[off + 11] = 0; out[off + 15] = 1;
    // perspective (WebGPU: near->0, far->1)
    const f = 1 / Math.tan(fov * 0.5);
    const rangeInv = 1 / (near - far);
    const p00 = f, p11 = f;
    const p22 = far * rangeInv, p23 = far * near * rangeInv;
    for (let c = 0; c < 4; c++) {
        const x = out[off + c * 4], y = out[off + c * 4 + 1], z = out[off + c * 4 + 2], w = out[off + c * 4 + 3];
        out[off + c * 4] = p00 * x;
        out[off + c * 4 + 1] = p11 * y;
        out[off + c * 4 + 2] = p22 * z + p23 * w;
        out[off + c * 4 + 3] = -z;
    }
}

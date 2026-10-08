import type { TgpuRoot, TgpuVertexFn, TgpuFragmentFn } from 'typegpu';
import { tgpu, d, std } from '../../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../../shaders/runtime-transpile';
import { DynamicMesh, StaticMesh } from '../../../../core/types';
import type { ShadowDrawBatch, ShadowModelLike } from './shadow-system';
import { createSkinnedLightLayout, createSkinnedLightVertex, createLightDistanceFragment } from './light-shadow-shaders';

/** Fixed number of spot lights that can cast a shadow in a frame. */
export const MAX_SPOT_SHADOWS = 4;

/** Per-light matrices + position/far + tunables, read by receiving materials. */
export const SpotShadowUniforms = d.struct({
    matrices: d.arrayOf(d.mat4x4f, MAX_SPOT_SHADOWS),
    /** xyz = light position, w = far distance. */
    lights: d.arrayOf(d.vec4f, MAX_SPOT_SHADOWS),
    /** x = active caster count, y = bias, z = 1/resolution, w unused. */
    params: d.vec4f,
});

/** Per-light uniform for the spot shadow pass. */
const SpotPassUniforms = d.struct({
    viewProjection: d.mat4x4f,
    /** xyz = light position, w = far. */
    lightPosFar: d.vec4f,
});

const PASS_FLOATS = 20;
const FLOATS = MAX_SPOT_SHADOWS * 16 + MAX_SPOT_SHADOWS * 4 + 4;

export interface SpotShadowSystemDeps {
    root: TgpuRoot;
    dynamicBuffer: GPUBuffer;
    staticBuffer: GPUBuffer;
    maxInstances: number;
    /** Skinned buffers; enables skinned casters when provided. */
    skinned?: {
        dynamicBuffer: GPUBuffer;
        staticBuffer: GPUBuffer;
        boneBuffer: GPUBuffer;
        maxInstances: number;
        maxBones: number;
        vertexBufferLayout: GPUVertexBufferLayout;
    };
}

export interface SpotShadowOptions {
    /** Max casting spot lights per frame. Defaults to `MAX_SPOT_SHADOWS`, clamped to it. */
    maxShadows?: number;
}

/** Per-frame pose of a shadow-casting spot light. */
export interface SpotLightInput {
    px: number; py: number; pz: number;
    dx: number; dy: number; dz: number;
    /** Cone half-angle (radians). */
    angle: number;
    range: number;
}

/**
 * Spot-light shadow maps. Renders casters into a `texture_2d_array` (one
 * perspective layer per casting spot), storing **linear distance / far** so the
 * comparison is well-conditioned. Lit materials project into it and PCF-sample.
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
    private readonly skinnedSlotIndexBuffer: GPUBuffer | null;
    private readonly skinnedPipeline: GPURenderPipeline | null;
    private readonly skinnedBindGroups: GPUBindGroup[] = [];
    private readonly passData = new Float32Array(PASS_FLOATS);
    private readonly layerViews: GPUTextureView[] = [];
    private readonly depthLayerViews: GPUTextureView[] = [];
    private map: GPUTexture;
    private depth: GPUTexture;
    private readonly mapView: GPUTextureView;

    readonly maxShadows: number;
    resolution = 1024;
    bias = 0.002;
    enabled = true;

    constructor(deps: SpotShadowSystemDeps, options: SpotShadowOptions = {}) {
        this.root = deps.root;
        this.device = deps.root.device;
        this.maxInstances = deps.maxInstances;
        this.maxShadows = Math.max(1, Math.min(options.maxShadows ?? MAX_SPOT_SHADOWS, MAX_SPOT_SHADOWS));
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
        const vertex = createSpotShadowVertex(this.layout);
        const fragment = createSpotShadowFragment(this.layout);
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

        for (let i = 0; i < this.maxShadows; i++) {
            const buf = this.device.createBuffer({ size: PASS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

        if (deps.skinned) {
            const s = deps.skinned;
            this.skinnedSlotIndexBuffer = this.device.createBuffer({ size: Math.max(4, s.maxInstances * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            const skinnedLayout = createSkinnedLightLayout(SpotPassUniforms, s.maxInstances, s.maxBones);
            const sVertex = createSkinnedLightVertex(skinnedLayout);
            const sFragment = createLightDistanceFragment(skinnedLayout as never);
            const { code: skinnedCode } = tgpu.resolveWithContext([sVertex, sFragment]);
            const skinnedModule = this.device.createShaderModule({ code: skinnedCode, label: 'spot-shadow-skinned' });
            const skinnedBgl = this.root.unwrap(skinnedLayout) as unknown as GPUBindGroupLayout;
            this.skinnedPipeline = this.device.createRenderPipeline({
                label: 'spot-shadow-skinned',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: [skinnedBgl] }),
                vertex: { module: skinnedModule, buffers: [s.vertexBufferLayout] },
                fragment: { module: skinnedModule, targets: [{ format: 'rgba16float' }] },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
            });
            for (let i = 0; i < this.maxShadows; i++) {
                this.skinnedBindGroups.push(this.device.createBindGroup({
                    layout: skinnedBgl,
                    entries: [
                        { binding: 0, resource: { buffer: this.passBuffers[i]! } },
                        { binding: 1, resource: { buffer: s.dynamicBuffer } },
                        { binding: 2, resource: { buffer: s.staticBuffer } },
                        { binding: 3, resource: { buffer: this.skinnedSlotIndexBuffer } },
                        { binding: 4, resource: { buffer: s.boneBuffer } },
                    ],
                }));
            }
        } else {
            this.skinnedSlotIndexBuffer = null;
            this.skinnedPipeline = null;
        }
    }

    get mapTexture(): GPUTextureView { return this.mapView; }
    get mapSampler(): GPUSampler { return this.sampler; }
    get uniforms(): GPUBuffer { return this.uniformBuffer; }

    setSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        if (count > 0) this.device.queue.writeBuffer(this.slotIndexBuffer, 0, slots, 0, count);
    }

    setSkinnedSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        if (count > 0 && this.skinnedSlotIndexBuffer) this.device.queue.writeBuffer(this.skinnedSlotIndexBuffer, 0, slots, 0, count);
    }

    render(encoder: GPUCommandEncoder, batches: ShadowDrawBatch[], getModel: (id: number) => ShadowModelLike | undefined, spots: readonly SpotLightInput[], skinnedBatches: ShadowDrawBatch[] = []): void {
        const count = this.enabled ? Math.min(spots.length, this.maxShadows) : 0;
        const m = this.uniformData;
        for (let i = 0; i < count; i++) {
            const s = spots[i]!;
            const far = Math.max(s.range, 0.1);
            perspectiveLookAt(this.passData, 0, s.px, s.py, s.pz, s.dx, s.dy, s.dz, Math.max(0.05, s.angle * 2), 0.5, far);
            this.passData[16] = s.px; this.passData[17] = s.py; this.passData[18] = s.pz; this.passData[19] = far;
            this.device.queue.writeBuffer(this.passBuffers[i]!, 0, this.passData);
            for (let k = 0; k < 16; k++) m[i * 16 + k] = this.passData[k]!;
            m[MAX_SPOT_SHADOWS * 16 + i * 4] = s.px;
            m[MAX_SPOT_SHADOWS * 16 + i * 4 + 1] = s.py;
            m[MAX_SPOT_SHADOWS * 16 + i * 4 + 2] = s.pz;
            m[MAX_SPOT_SHADOWS * 16 + i * 4 + 3] = far;

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
            if (skinnedBatches.length > 0 && this.skinnedPipeline && this.skinnedBindGroups[i]) {
                pass.setPipeline(this.skinnedPipeline);
                pass.setBindGroup(0, this.skinnedBindGroups[i]!);
                let sCurrent: GPUBuffer | null = null;
                for (const batch of skinnedBatches) {
                    const model = getModel(batch.modelId);
                    if (!model) continue;
                    if (model.rawVertexBuffer !== sCurrent) { pass.setVertexBuffer(0, model.rawVertexBuffer); sCurrent = model.rawVertexBuffer; }
                    if (model.rawIndexBuffer) {
                        pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                        pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                    } else {
                        pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                    }
                }
            }
            pass.end();
        }
        const p = MAX_SPOT_SHADOWS * 20;
        m[p] = count;
        m[p + 1] = this.bias;
        m[p + 2] = 1 / this.resolution;
        m[p + 3] = 0;
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
        const map = this.device.createTexture({ size: [res, res, this.maxShadows], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        const depth = this.device.createTexture({ size: [res, res, this.maxShadows], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
        this.layerViews.length = 0;
        this.depthLayerViews.length = 0;
        for (let i = 0; i < this.maxShadows; i++) {
            this.layerViews.push(map.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
            this.depthLayerViews.push(depth.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
        }
        return { map, mapView: map.createView({ dimension: '2d-array' }), depth };
    }
}

function createSpotLayout(maxInstances: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: SpotPassUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(StaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
    });
}

function createSpotShadowVertex(layout: ReturnType<typeof createSpotLayout>): TgpuVertexFn {
    const _WS = ['d', 'std', 'layout', 'mix', 'cos', 'sin', 'mul'];
    const fn = function(input: { position: { x: number; y: number; z: number }; uv: { x: number; y: number }; instanceIndex: number }) {
        const slot = layout.$.slotIndices[input.instanceIndex];
        const dyn = layout.$.dynamicInstances[slot];
        const stat = layout.$.staticInstances[slot];
        const scaled = d.vec3f(
            std.mul(input.position.x, stat.scaleX),
            std.mul(input.position.y, stat.scaleY),
            std.mul(input.position.z, stat.scaleZ),
        );
        const czr = std.cos(dyn.currRotZ), szr = std.sin(dyn.currRotZ);
        const rz1 = d.vec3f(
            std.sub(std.mul(scaled.x, czr), std.mul(scaled.y, szr)),
            std.add(std.mul(scaled.x, szr), std.mul(scaled.y, czr)),
            scaled.z,
        );
        const cyr = std.cos(dyn.currRotY), syr = std.sin(dyn.currRotY);
        const ry1 = d.vec3f(
            std.add(std.mul(rz1.x, cyr), std.mul(rz1.z, syr)),
            rz1.y,
            std.sub(std.mul(rz1.z, cyr), std.mul(rz1.x, syr)),
        );
        const cxr = std.cos(dyn.currRotX), sxr = std.sin(dyn.currRotX);
        const rx1 = d.vec3f(
            ry1.x,
            std.sub(std.mul(ry1.y, cxr), std.mul(ry1.z, sxr)),
            std.add(std.mul(ry1.y, sxr), std.mul(ry1.z, cxr)),
        );
        const world = d.vec4f(std.add(rx1.x, dyn.currPosX), std.add(rx1.y, dyn.currPosY), std.add(rx1.z, dyn.currPosZ), 1.0);
        const clip = std.mul(layout.$.uniforms.viewProjection, world);
        return { pos: clip, vWorld: d.vec3f(world.x, world.y, world.z) };
    };
    attachShaderMetadata(fn as any, () => ({ d, std, layout }), false, { d, std, layout }, _WS);
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            uv: d.location(2, d.vec2f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: { pos: d.builtin.position, vWorld: d.vec3f },
    } as any)(fn as any);
}

function createSpotShadowFragment(layout: ReturnType<typeof createSpotLayout>): TgpuFragmentFn {
    const fn = function(input: { vWorld: { x: number; y: number; z: number } }) {
        const lp = layout.$.uniforms.lightPosFar;
        const dist = std.length(d.vec3f(input.vWorld.x - lp.x, input.vWorld.y - lp.y, input.vWorld.z - lp.z)) / lp.w;
        return d.vec4f(dist, dist, dist, 1.0);
    };
    attachShaderMetadata(fn as any, () => ({ d, std, layout }), false, { d, std, layout });
    return tgpu.fragmentFn({ in: { vWorld: d.vec3f }, out: d.vec4f } as any)(fn as any);
}

/** `proj * view` for a spot light (column-major, WebGPU depth). */
function perspectiveLookAt(
    out: Float32Array, off: number,
    ex: number, ey: number, ez: number,
    dx: number, dy: number, dz: number,
    fov: number, near: number, far: number,
): void {
    const dl = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / dl, fy = dy / dl, fz = dz / dl;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(fy) > 0.99) { ux = 1; uy = 0; uz = 0; }
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux2 = ry * fz - rz * fy, uy2 = rz * fx - rx * fz, uz2 = rx * fy - ry * fx;
    const zx = -fx, zy = -fy, zz = -fz;
    out[off + 0] = rx; out[off + 4] = ry; out[off + 8] = rz; out[off + 12] = -(rx * ex + ry * ey + rz * ez);
    out[off + 1] = ux2; out[off + 5] = uy2; out[off + 9] = uz2; out[off + 13] = -(ux2 * ex + uy2 * ey + uz2 * ez);
    out[off + 2] = zx; out[off + 6] = zy; out[off + 10] = zz; out[off + 14] = -(zx * ex + zy * ey + zz * ez);
    out[off + 3] = 0; out[off + 7] = 0; out[off + 11] = 0; out[off + 15] = 1;
    const f = 1 / Math.tan(fov * 0.5);
    const rangeInv = 1 / (near - far);
    const p22 = far * rangeInv, p23 = far * near * rangeInv;
    for (let c = 0; c < 4; c++) {
        const x = out[off + c * 4], y = out[off + c * 4 + 1], z = out[off + c * 4 + 2], w = out[off + c * 4 + 3];
        out[off + c * 4] = f * x;
        out[off + c * 4 + 1] = f * y;
        out[off + c * 4 + 2] = p22 * z + p23 * w;
        out[off + c * 4 + 3] = -z;
    }
}

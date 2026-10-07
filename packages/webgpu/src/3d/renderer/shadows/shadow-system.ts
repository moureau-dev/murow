import type { TgpuRoot } from 'typegpu';
import { tgpu, d, std } from '../../../shaders/typegpu';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import { DynamicMesh, SkinnedStaticMesh, StaticMesh } from '../../../core/types';

/** Light-space matrix + tunables, shared by the shadow pass and receivers. */
export const ShadowUniforms = d.struct({
    viewProjection: d.mat4x4f,
    /** x = enabled (0/1), y = bias, z = 1/resolution (UV texel), w = softness (texels). */
    params: d.vec4f,
    /** Pose-interpolation factor, matched to the main pass. */
    alpha: d.f32,
    /** World size of one texel (for normal-offset bias). */
    texelWorldSize: d.f32,
    _pad0: d.f32,
    _pad1: d.f32,
});

export interface ShadowSystemDeps {
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

export interface ShadowOptions {
    /** Shadow map resolution (square). Default 2048. */
    resolution?: number;
}

export interface ShadowDrawBatch {
    modelId: number;
    offset: number;
    count: number;
}

export interface ShadowModelLike {
    rawVertexBuffer: GPUBuffer;
    rawIndexBuffer: GPUBuffer | null;
    indexFormat: GPUIndexFormat;
    indexCount: number;
    vertexCount: number;
}

const FLOATS = 16 + 4 + 4;

/**
 * Directional shadow map. Renders the scene from the sun into an `rgba16float`
 * linear-depth map (a color target, not a depth texture, so materials can
 * sample it through the declarative pipeline), then lit fragments compare
 * against it with a 3x3 PCF.
 */
export class ShadowSystem {
    private readonly root: TgpuRoot;
    private readonly device: GPUDevice;
    private readonly maxInstances: number;
    /** Slot indices of casters, written per frame from the all-instance list. */
    private readonly slotIndexBuffer: GPUBuffer;

    /** Mutable settings; all uniform-driven except `resolution`. */
    enabled = true;
    softness = 1;
    bias = 0.0015;
    /** Orthographic half-extent fitted around the camera position. */
    distance = 45;
    /**
     * Grid the focus point snaps to. The box only recenters when the focus
     * crosses a cell, so a static scene reuses the shadow map. `0` uses
     * `distance` (coverage around the camera still holds since the half-extent
     * is larger than the cell).
     */
    anchorStep = 0;

    private readonly lastSun = new Float32Array(3).fill(NaN);
    private readonly lastAnchor = new Float32Array(3).fill(NaN);
    private hasBox = false;

    private resolutionValue: number;
    private map: GPUTexture;
    private mapView: GPUTextureView;
    private depth: GPUTexture;
    private depthView: GPUTextureView;
    private readonly sampler: GPUSampler;
    private readonly uniformBuffer: GPUBuffer;
    private readonly uniformData = new Float32Array(FLOATS);
    private readonly layout: ReturnType<typeof createShadowLayout>;
    private readonly pipeline: GPURenderPipeline;
    private readonly bindGroup: GPUBindGroup;
    private readonly skinnedSlotIndexBuffer: GPUBuffer | null;
    private readonly skinnedPipeline: GPURenderPipeline | null;
    private readonly skinnedBindGroup: GPUBindGroup | null;
    private resolutionHook: (() => void) | null = null;

    constructor(deps: ShadowSystemDeps, options: ShadowOptions = {}) {
        this.root = deps.root;
        this.device = deps.root.device;
        this.maxInstances = deps.maxInstances;
        this.resolutionValue = options.resolution ?? 2048;
        this.slotIndexBuffer = this.device.createBuffer({
            size: Math.max(4, deps.maxInstances * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Linear filtering bilinear-averages each PCF tap, which smooths the
        // texel grid into a soft penumbra.
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
        const targets = this.createTargets(this.resolutionValue);
        this.map = targets.map;
        this.mapView = targets.mapView;
        this.depth = targets.depth;
        this.depthView = this.depth.createView();

        this.uniformBuffer = this.device.createBuffer({
            size: FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.layout = createShadowLayout(deps.maxInstances);
        const vertex = createShadowVertex(this.layout);
        const fragment = createShadowFragment();
        const { code } = tgpu.resolveWithContext([vertex, fragment]);
        const module = this.device.createShaderModule({ code, label: 'shadow-map' });
        const bgl = this.root.unwrap(this.layout) as unknown as GPUBindGroupLayout;
        this.pipeline = this.device.createRenderPipeline({
            label: 'shadow-map',
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

        this.bindGroup = this.device.createBindGroup({
            layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: deps.dynamicBuffer } },
                { binding: 2, resource: { buffer: deps.staticBuffer } },
                { binding: 3, resource: { buffer: this.slotIndexBuffer } },
            ],
        });

        if (deps.skinned) {
            const s = deps.skinned;
            this.skinnedSlotIndexBuffer = this.device.createBuffer({
                size: Math.max(4, s.maxInstances * 4),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            const skinnedLayout = createSkinnedShadowLayout(s.maxInstances, s.maxBones);
            const skinnedVertex = createSkinnedShadowVertex(skinnedLayout);
            const { code: skinnedCode } = tgpu.resolveWithContext([skinnedVertex, createShadowFragment()]);
            const skinnedModule = this.device.createShaderModule({ code: skinnedCode, label: 'shadow-skinned' });
            const skinnedBgl = this.root.unwrap(skinnedLayout) as unknown as GPUBindGroupLayout;
            this.skinnedPipeline = this.device.createRenderPipeline({
                label: 'shadow-skinned',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: [skinnedBgl] }),
                vertex: { module: skinnedModule, buffers: [s.vertexBufferLayout] },
                fragment: { module: skinnedModule, targets: [{ format: 'rgba16float' }] },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
            });
            this.skinnedBindGroup = this.device.createBindGroup({
                layout: skinnedBgl,
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer } },
                    { binding: 1, resource: { buffer: s.dynamicBuffer } },
                    { binding: 2, resource: { buffer: s.staticBuffer } },
                    { binding: 3, resource: { buffer: this.skinnedSlotIndexBuffer } },
                    { binding: 4, resource: { buffer: s.boneBuffer } },
                ],
            });
        } else {
            this.skinnedSlotIndexBuffer = null;
            this.skinnedPipeline = null;
            this.skinnedBindGroup = null;
        }
    }

    /**
     * Shadow map size. Assigning rebuilds the map and rebinds every receiving
     * material (a one-time hitch), so it is safe to change at any time.
     */
    get resolution(): number { return this.resolutionValue; }
    set resolution(res: number) {
        if (res === this.resolutionValue) return;
        this.setResolution(res);
        this.resolutionHook?.();
    }
    /** Called by the renderer after a resolution change so materials rebind. */
    setResolutionHook(fn: () => void): void { this.resolutionHook = fn; }
    /** Uniform buffer holding `ShadowUniforms`, bound by receiving materials. */
    get uniforms(): GPUBuffer { return this.uniformBuffer; }
    /** Current light view-projection (column-major, 16 floats), for culling. */
    get viewProjection(): Float32Array { return this.uniformData.subarray(0, 16); }
    get mapTexture(): GPUTextureView { return this.mapView; }
    get mapSampler(): GPUSampler { return this.sampler; }

    /**
     * Recompute the sun's orthographic view-projection around `focus`.
     * `sunDir` points toward the light. Returns `true` when the sun or the
     * (snapped) focus changed, i.e. the map must be re-rendered; `false` means
     * the previous map is still valid and the pass can be skipped.
     */
    update(sunDir: readonly [number, number, number], focus: readonly [number, number, number]): boolean {
        const [dx, dy, dz] = sunDir;
        const len = Math.hypot(dx, dy, dz) || 1;
        const snx = dx / len, sny = dy / len, snz = dz / len;
        const step = this.anchorStep > 0 ? this.anchorStep : this.distance;
        const ax = Math.round(focus[0] / step) * step;
        const ay = Math.round(focus[1] / step) * step;
        const az = Math.round(focus[2] / step) * step;
        const sunMoved = Math.abs(snx - this.lastSun[0]!) > 1e-4
            || Math.abs(sny - this.lastSun[1]!) > 1e-4
            || Math.abs(snz - this.lastSun[2]!) > 1e-4;
        const anchorMoved = ax !== this.lastAnchor[0]! || ay !== this.lastAnchor[1]! || az !== this.lastAnchor[2]!;
        // The map must be re-rendered only when the box (sun or anchor) changed.
        // Uniform-only settings (bias/softness/enabled) are always written below.
        const boxChanged = !this.hasBox || sunMoved || anchorMoved;
        this.hasBox = true;
        this.lastSun[0] = snx; this.lastSun[1] = sny; this.lastSun[2] = snz;
        this.lastAnchor[0] = ax; this.lastAnchor[1] = ay; this.lastAnchor[2] = az;

        const m = this.uniformData;
        const center: readonly [number, number, number] = [ax, ay, az];
        // View forward is the light's travel direction (opposite the surface-to-light vector).
        const fx = -snx, fy = -sny, fz = -snz;
        // Light basis (matches orthoLookAt) so the frustum center can be snapped
        // to whole texels, which stops static shadows from swimming.
        let upx = 0, upy = 1, upz = 0;
        if (Math.abs(fy) > 0.99) { upx = 1; upy = 0; upz = 0; }
        let rx = fy * upz - fz * upy, ry = fz * upx - fx * upz, rz = fx * upy - fy * upx;
        const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
        const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
        const radius = this.distance;
        const texelWorld = (radius * 2) / this.resolutionValue;
        const ccx = center[0] * rx + center[1] * ry + center[2] * rz;
        const ccy = center[0] * ux + center[1] * uy + center[2] * uz;
        const t0 = Math.round(ccx / texelWorld) * texelWorld - ccx;
        const t1 = Math.round(ccy / texelWorld) * texelWorld - ccy;
        const tx = center[0] + t0 * rx + t1 * ux;
        const ty = center[1] + t0 * ry + t1 * uy;
        const tz = center[2] + t0 * rz + t1 * uz;
        const eyeX = tx - fx * radius * 2;
        const eyeY = ty - fy * radius * 2;
        const eyeZ = tz - fz * radius * 2;
        orthoLookAt(m, 0, eyeX, eyeY, eyeZ, tx, ty, tz, fx, fy, fz, radius);
        m[16] = this.enabled ? 1 : 0;
        m[17] = this.bias;
        m[18] = 1 / this.resolutionValue;
        m[19] = this.softness;
        // Casters are rendered at the current (tick) pose, not interpolated, so
        // the cached map is consistent across the frames within a tick.
        m[20] = 1;
        m[21] = texelWorld;
        m[22] = 0; m[23] = 0;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, m);
        return boxChanged;
    }

    /**
     * Upload the caster slot indices for this frame. The renderer builds these
     * from all live instances (not the camera-culled set) so off-screen casters
     * still cast.
     */
    setSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        if (count > 0) this.device.queue.writeBuffer(this.slotIndexBuffer, 0, slots, 0, count);
    }

    /** Upload the skinned caster slot indices for this frame. */
    setSkinnedSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        if (count > 0 && this.skinnedSlotIndexBuffer) {
            this.device.queue.writeBuffer(this.skinnedSlotIndexBuffer, 0, slots, 0, count);
        }
    }

    /** Encode the shadow pass into `encoder` (before the main pass). */
    encode(encoder: GPUCommandEncoder, batches: ShadowDrawBatch[], getModel: (id: number) => ShadowModelLike | undefined, skinnedBatches: ShadowDrawBatch[] = []): void {
        if (!this.enabled) return;
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.mapView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
            }],
            depthStencilAttachment: {
                view: this.depthView,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 1.0,
            },
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        this.drawBatches(pass, batches, getModel);
        pass.end();

        // Skinned casters into the same map (load the cleared depth/color).
        if (skinnedBatches.length > 0 && this.skinnedPipeline && this.skinnedBindGroup) {
            const spass = encoder.beginRenderPass({
                colorAttachments: [{ view: this.mapView, loadOp: 'load', storeOp: 'store' }],
                depthStencilAttachment: { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
            });
            spass.setPipeline(this.skinnedPipeline);
            spass.setBindGroup(0, this.skinnedBindGroup);
            this.drawBatches(spass, skinnedBatches, getModel);
            spass.end();
        }
    }

    private drawBatches(pass: GPURenderPassEncoder, batches: ShadowDrawBatch[], getModel: (id: number) => ShadowModelLike | undefined): void {
        let current: GPUBuffer | null = null;
        for (const batch of batches) {
            const model = getModel(batch.modelId);
            if (!model) continue;
            if (model.rawVertexBuffer !== current) {
                pass.setVertexBuffer(0, model.rawVertexBuffer);
                current = model.rawVertexBuffer;
            }
            if (model.rawIndexBuffer) {
                pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
            } else {
                pass.draw(model.vertexCount, batch.count, 0, batch.offset);
            }
        }
    }

    /** Rebuild the shadow map at a new resolution. Invalidates receiver bind groups. */
    setResolution(res: number): void {
        if (res === this.resolutionValue) return;
        this.resolutionValue = res;
        this.map.destroy();
        this.depth.destroy();
        const targets = this.createTargets(res);
        this.map = targets.map;
        this.mapView = targets.mapView;
        this.depth = targets.depth;
        this.depthView = this.depth.createView();
    }

    destroy(): void {
        this.map.destroy();
        this.depth.destroy();
        this.uniformBuffer.destroy();
        this.slotIndexBuffer.destroy();
        this.skinnedSlotIndexBuffer?.destroy();
    }

    private createTargets(res: number): { map: GPUTexture; mapView: GPUTextureView; depth: GPUTexture } {
        const map = this.device.createTexture({
            size: [res, res, 1],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const depth = this.device.createTexture({
            size: [res, res, 1],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        return { map, mapView: map.createView(), depth };
    }
}

function createShadowLayout(maxInstances: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: ShadowUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(StaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
    });
}

function createShadowVertex(layout: ReturnType<typeof createShadowLayout>) {
    const _WS = ['d', 'std', 'layout', 'mix', 'cos', 'sin', 'mul'];
    const fn = function(input: { position: { x: number; y: number; z: number }; uv: { x: number; y: number }; instanceIndex: number }) {
        const slot = layout.$.slotIndices[input.instanceIndex];
        const dyn = layout.$.dynamicInstances[slot];
        const stat = layout.$.staticInstances[slot];
        const alpha = layout.$.uniforms.alpha;

        const px = std.mix(dyn.prevPosX, dyn.currPosX, alpha);
        const py = std.mix(dyn.prevPosY, dyn.currPosY, alpha);
        const pz = std.mix(dyn.prevPosZ, dyn.currPosZ, alpha);
        const rx = std.mix(dyn.prevRotX, dyn.currRotX, alpha);
        const ry = std.mix(dyn.prevRotY, dyn.currRotY, alpha);
        const rz = std.mix(dyn.prevRotZ, dyn.currRotZ, alpha);

        const scaled = d.vec3f(
            std.mul(input.position.x, stat.scaleX),
            std.mul(input.position.y, stat.scaleY),
            std.mul(input.position.z, stat.scaleZ),
        );
        const czr = std.cos(rz), szr = std.sin(rz);
        const rz1 = d.vec3f(
            std.sub(std.mul(scaled.x, czr), std.mul(scaled.y, szr)),
            std.add(std.mul(scaled.x, szr), std.mul(scaled.y, czr)),
            scaled.z,
        );
        const cyr = std.cos(ry), syr = std.sin(ry);
        const ry1 = d.vec3f(
            std.add(std.mul(rz1.x, cyr), std.mul(rz1.z, syr)),
            rz1.y,
            std.sub(std.mul(rz1.z, cyr), std.mul(rz1.x, syr)),
        );
        const cxr = std.cos(rx), sxr = std.sin(rx);
        const rx1 = d.vec3f(
            ry1.x,
            std.sub(std.mul(ry1.y, cxr), std.mul(ry1.z, sxr)),
            std.add(std.mul(ry1.y, sxr), std.mul(ry1.z, cxr)),
        );
        const world = d.vec4f(std.add(rx1.x, px), std.add(rx1.y, py), std.add(rx1.z, pz), 1.0);
        const clip = std.mul(layout.$.uniforms.viewProjection, world);
        return { pos: clip, vDepth: clip.z / clip.w * 0.5 + 0.5 };
    };
    attachShaderMetadata(fn as any, () => ({ d, std, layout }), false, { d, std, layout }, _WS);
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            uv: d.location(2, d.vec2f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: { pos: d.builtin.position, vDepth: d.f32 },
    } as any)(fn as any);
}

function createShadowFragment() {
    const fn = function(input: { vDepth: number }) {
        return d.vec4f(input.vDepth, input.vDepth, input.vDepth, 1.0);
    };
    attachShaderMetadata(fn as any, () => ({ d, std }), false, { d, std });
    return tgpu.fragmentFn({ in: { vDepth: d.f32 }, out: d.vec4f } as any)(fn as any);
}

function createSkinnedShadowLayout(maxInstances: number, maxBones: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: ShadowUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicMesh, maxInstances) },
        staticInstances: { storage: d.arrayOf(SkinnedStaticMesh, maxInstances) },
        slotIndices: { storage: d.arrayOf(d.u32, maxInstances) },
        boneMatrices: { storage: d.arrayOf(d.mat4x4f, maxBones) },
    });
}

function createSkinnedShadowVertex(layout: ReturnType<typeof createSkinnedShadowLayout>) {
    const _WS = ['d', 'std', 'layout', 'mix', 'cos', 'sin', 'mul', 'mat4x4f'];
    const fn = function(input: {
        position: { x: number; y: number; z: number };
        normal: { x: number; y: number; z: number };
        uv: { x: number; y: number };
        joints: { x: number; y: number; z: number; w: number };
        weights: { x: number; y: number; z: number; w: number };
        instanceIndex: number;
    }) {
        const slot = layout.$.slotIndices[input.instanceIndex];
        const dyn = layout.$.dynamicInstances[slot];
        const stat = layout.$.staticInstances[slot];
        const alpha = layout.$.uniforms.alpha;
        const boneOffset = stat.boneOffset;

        const j0 = input.joints.x, j1 = input.joints.y, j2 = input.joints.z, j3 = input.joints.w;
        const w0 = input.weights.x, w1 = input.weights.y, w2 = input.weights.z, w3 = input.weights.w;

        const bm = layout.$.boneMatrices;
        const m0 = bm[(d.i32(boneOffset) + d.i32(j0))];
        const m1 = bm[(d.i32(boneOffset) + d.i32(j1))];
        const m2 = bm[(d.i32(boneOffset) + d.i32(j2))];
        const m3 = bm[(d.i32(boneOffset) + d.i32(j3))];

        const p = d.vec4f(input.position.x, input.position.y, input.position.z, 1.0);
        // @ts-ignore — TGSL: matrix * vector
        const sp0 = m0 * p as unknown as d.v4f;
        // @ts-ignore
        const sp1 = m1 * p as unknown as d.v4f;
        // @ts-ignore
        const sp2 = m2 * p as unknown as d.v4f;
        // @ts-ignore
        const sp3 = m3 * p as unknown as d.v4f;

        const skinned = d.vec3f(
            sp0.x * w0 + sp1.x * w1 + sp2.x * w2 + sp3.x * w3,
            sp0.y * w0 + sp1.y * w1 + sp2.y * w2 + sp3.y * w3,
            sp0.z * w0 + sp1.z * w1 + sp2.z * w2 + sp3.z * w3,
        );

        const px = std.mix(dyn.prevPosX, dyn.currPosX, alpha);
        const py = std.mix(dyn.prevPosY, dyn.currPosY, alpha);
        const pz = std.mix(dyn.prevPosZ, dyn.currPosZ, alpha);
        const rx = std.mix(dyn.prevRotX, dyn.currRotX, alpha);
        const ry = std.mix(dyn.prevRotY, dyn.currRotY, alpha);
        const rz = std.mix(dyn.prevRotZ, dyn.currRotZ, alpha);

        const scaled = d.vec3f(skinned.x * stat.scaleX, skinned.y * stat.scaleY, skinned.z * stat.scaleZ);
        const czr = std.cos(rz), szr = std.sin(rz);
        const rz1 = d.vec3f(
            std.sub(std.mul(scaled.x, czr), std.mul(scaled.y, szr)),
            std.add(std.mul(scaled.x, szr), std.mul(scaled.y, czr)),
            scaled.z,
        );
        const cyr = std.cos(ry), syr = std.sin(ry);
        const ry1 = d.vec3f(
            std.add(std.mul(rz1.x, cyr), std.mul(rz1.z, syr)),
            rz1.y,
            std.sub(std.mul(rz1.z, cyr), std.mul(rz1.x, syr)),
        );
        const cxr = std.cos(rx), sxr = std.sin(rx);
        const rx1 = d.vec3f(
            ry1.x,
            std.sub(std.mul(ry1.y, cxr), std.mul(ry1.z, sxr)),
            std.add(std.mul(ry1.y, sxr), std.mul(ry1.z, cxr)),
        );
        const world = d.vec4f(std.add(rx1.x, px), std.add(rx1.y, py), std.add(rx1.z, pz), 1.0);
        const clip = std.mul(layout.$.uniforms.viewProjection, world);
        return { pos: clip, vDepth: clip.z / clip.w * 0.5 + 0.5 };
    };
    attachShaderMetadata(fn as any, () => ({ d, std, layout }), false, { d, std, layout }, _WS);
    return tgpu.vertexFn({
        in: {
            position: d.location(0, d.vec3f),
            normal: d.location(1, d.vec3f),
            uv: d.location(2, d.vec2f),
            joints: d.location(3, d.vec4u),
            weights: d.location(4, d.vec4f),
            instanceIndex: d.builtin.instanceIndex,
        },
        out: { pos: d.builtin.position, vDepth: d.f32 },
    } as any)(fn as any);
}

/** Write `proj * view` for an orthographic box of half-extent `radius`. */
function orthoLookAt(
    out: Float32Array, offset: number,
    ex: number, ey: number, ez: number,
    tx: number, ty: number, tz: number,
    fx: number, fy: number, fz: number,
    radius: number,
): void {
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(fy) > 0.99) { ux = 1; uy = 0; uz = 0; }
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux2 = ry * fz - rz * fy, uy2 = rz * fx - rx * fz, uz2 = rx * fy - ry * fx;
    const zx = -fx, zy = -fy, zz = -fz;

    out[offset + 0] = rx; out[offset + 4] = ry; out[offset + 8] = rz; out[offset + 12] = -(rx * ex + ry * ey + rz * ez);
    out[offset + 1] = ux2; out[offset + 5] = uy2; out[offset + 9] = uz2; out[offset + 13] = -(ux2 * ex + uy2 * ey + uz2 * ez);
    out[offset + 2] = zx; out[offset + 6] = zy; out[offset + 10] = zz; out[offset + 14] = -(zx * ex + zy * ey + zz * ez);
    out[offset + 3] = 0; out[offset + 7] = 0; out[offset + 11] = 0; out[offset + 15] = 1;

    const r = radius, t = radius, l = -radius, b = -radius;
    const p00 = 2 / (r - l), p11 = 2 / (t - b);
    const p03 = 0, p13 = 0;
    const p22 = -1 / radius;
    const p23 = -2;
    for (let c = 0; c < 4; c++) {
        const x = out[offset + c * 4], y = out[offset + c * 4 + 1], z = out[offset + c * 4 + 2], w = out[offset + c * 4 + 3];
        out[offset + c * 4] = p00 * x + p03 * w;
        out[offset + c * 4 + 1] = p11 * y + p13 * w;
        out[offset + c * 4 + 2] = p22 * z + p23 * w;
        out[offset + c * 4 + 3] = w;
    }
}

/**
 * WebGPU3DRenderer — instanced 3D mesh renderer backed by TypeGPU.
 *
 * - One draw call per model type (all instances batched)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation + TRS transform in vertex shader
 * - GPU index buffer for sparse instancing
 * - Depth testing + back-face culling
 */

import type { RawBuffer, RawCommandEncoder, RawRenderPassEncoder } from 'murow/gpu';
import { RawBufferUsage } from 'murow/gpu';
import { Base3DRenderer } from 'murow/renderer';
import { runtime } from '../runtime';
import { createOcclusion } from '../../compute/occlusion';
import { d } from '../../gpu';
import { MESH_UNIFORM_LIGHT_OFFSET } from 'murow/renderer/managers/runtime';
import { Logger } from 'murow/core';
import {
    type AssetBucket,
    type PrefabBucket3D,
} from 'murow/renderer';
import {
    InstanceManager,
    MaterialManager,
    LightManager,
    ShadowManager,
    DecalManager,
    ParticleManager,
    CameraManager,
    ModelsManager,
} from 'murow/renderer/managers/runtime';
import { RendererManagers } from 'murow/renderer/managers';
import type { RendererRuntime } from 'murow/renderer/managers';
import { CameraEffectStack } from 'murow/renderer/managers/runtime';
import {
    ResizeController,
    Raycast3D,
    MeshPipelines,
    SkeletalRuntime,
    SkinCull,
} from 'murow/renderer/managers/runtime';
import { RendererCore, SceneUniforms } from 'murow/renderer/managers/runtime';
import { MainPass } from 'murow/renderer/managers/runtime';
import { HitboxDebugRenderer } from 'murow/renderer/managers/runtime';
import { DEFAULT_CAPACITIES } from 'murow/renderer/managers/runtime';
import type {
    Interpolator,
    WebGPU3DRendererOptions,
} from 'murow/renderer/managers/runtime';

/** Compute auto-sizing stats from a loaded prefab bucket. */
function computeBucketStats(bucket: PrefabBucket3D): { maxSkinnedParts: number; maxJointCount: number } {
    let maxSkinnedParts = 0;
    let maxJointCount = 0;
    for (const prefab of bucket.entries()) {
        if (prefab.type === 'gltf') {
            if (prefab.skinnedPartCount > maxSkinnedParts) maxSkinnedParts = prefab.skinnedPartCount;
            if (prefab.jointCount > maxJointCount) maxJointCount = prefab.jointCount;
        }
    }
    return { maxSkinnedParts, maxJointCount };
}


/** Fill `outRight`/`outUp` with the camera basis (world space) and return `outRight`. */
function cameraBasis(
    position: readonly [number, number, number],
    target: readonly [number, number, number],
    up: readonly [number, number, number],
    outRight: Float32Array,
    outUp: Float32Array,
): Float32Array {
    let fx = target[0] - position[0], fy = target[1] - position[1], fz = target[2] - position[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    outRight[0] = rx; outRight[1] = ry; outRight[2] = rz;
    outUp[0] = ry * fz - rz * fy;
    outUp[1] = rz * fx - rx * fz;
    outUp[2] = rx * fy - ry * fx;
    return outRight;
}

import { OcclusionTrackerImpl, type OcclusionTrackable, type OcclusionTracker } from './occlusion-tracker';
export type { OcclusionTrackable, OcclusionTracker } from './occlusion-tracker';
export { OcclusionTrackerImpl } from './occlusion-tracker';

/** The WebGPU 3D renderer: instances, materials, lights, skinning, and camera effects. */
export class WebGPU3DRenderer<A extends AssetBucket<'3d', any, any> = AssetBucket<'3d', any, any>> extends Base3DRenderer {
    private core!: RendererCore;
    private resize!: ResizeController;

    private readonly maxTotalBones: number;

    // Skeletal animation runtime (clip packing, compute kernel, bone buffer).
    private animation!: SkeletalRuntime;

    private readonly maxSkinnedInstances: number;
    private readonly maxBonesPerSkin: number;
    /**
     * View-projection the occlusion cull uses. The pyramid is built from the
     * previous frame's depth, so the cull must project with the same camera the
     * pyramid was built with; using the current one makes silhouettes flicker.
     */
    private occlusionVp: import('murow/gpu').RawBuffer | null = null;
    private readonly prevVp = new Float32Array(16);
    /** Per-model [half, center] bounds buffer the occlusion cull reads. */
    private modelBoundsBuffer: import('murow/gpu').RawBuffer | null = null;
    private readonly modelBoundsCapacity = 4096;
    private boundsScratch: Float32Array | null = null;

    // Occlusion trackers: { isOccluded(handle) } caches refreshed on a tick counter.
    private readonly occlusionTrackers: OcclusionTrackerImpl[] = [];
    private occlusionTicks = 0;
    private occlusionPending = false;
    private readonly occlusionInterval: number;

    private readonly skinCull: SkinCull;

    readonly camera: CameraManager;
    raycast!: Raycast3D;
    /** Names auto-assigned to internal (decal) materials that have none. */
    private decalMaterialSeq = 0;
    private lastRenderTime = 0;
    /** Accumulated render time (seconds), exposed to shaders as `scene.time`. */
    private elapsed = 0;
    private cameraEffects!: CameraEffectStack;
    private readonly maxCameraEffects: number;
    private readonly logger: Logger;
    private readonly _camRight = new Float32Array(3);
    private readonly _camUp = new Float32Array(3);

    /** Subsystems snapshotted on pre-tick for frame interpolation. */
    private interpolators: Interpolator[] = [];

    /** Non-skinned and skinned instance pool facade. */
    instances!: InstanceManager;
    /** Compiled material facade. */
    materials!: MaterialManager;
    /** Dynamic light facade. */
    lights!: LightManager;
    /** Shadow passes facade. */
    shadows!: ShadowManager;
    /** Decal layer facade. */
    decals!: DecalManager;
    /** GPU particle facade. */
    particles!: ParticleManager;
    /** Mesh creation and loading facade. */
    models!: ModelsManager;

    private readonly _assets: AssetBucket<'3d', any, any> | null;
    private readonly _prefabs: PrefabBucket3D | null;

    debug: { hitboxes: boolean } = { hitboxes: false };

    /**
     * Occlusion-culling status and per-frame stats. `enabled` reflects the
     * `occlusion.enabled` option; culling only runs when the runtime also
     * provides an occlusion port.
     */
    readonly occlusion: {
        enabled: boolean;
        /** NDC depth margin before culling; higher = less eager. Tunable live. */
        bias: number;
        readonly stats: { batches: number; candidates: number };
        /** Diagnostic readback of the per-batch indirect args (forces a GPU sync). */
        readArgs(): Promise<Uint32Array>;
        /** Per-slot visibility (1 = drawn, 0 = occluded), async readback. */
        readVisibility(): Promise<{ static: Uint32Array; skinned: Uint32Array }>;
        /** Whether an instance handle is currently occluded. */
        isOccluded(handle: { slot: number; skinned?: boolean }): Promise<boolean>;
        /**
         * Watch a fixed set of handles. The renderer refreshes their occlusion
         * state automatically; read it synchronously off the hot path.
         */
        track(handles: readonly OcclusionTrackable[]): OcclusionTracker;
        /**
         * Refresh every live tracker. Called from `storePreviousState`; no-op
         * unless `interval` ticks have passed and no readback is in flight.
         */
        update(): void;
    };

    private hitboxDebug = new HitboxDebugRenderer();
    private mainPass!: MainPass;
    private runtime!: RendererRuntime;

    constructor(canvas: HTMLCanvasElement, options: WebGPU3DRendererOptions<A>) {
        // Resolve maxInstances from the bucket before delegating to super:
        // default to `bucket.size + slack` so non-skinned prefabs (grids, primitives)
        // always have room without the user having to count them by hand.
        const resolvedMaxInstances = options.maxInstances
            ?? (options.assets ? options.assets.prefabs.size + 16 : 32);
        super(canvas, { ...options, maxInstances: resolvedMaxInstances });
        this.core = new RendererCore();
        this.maxCameraEffects = options.maxCameraEffects ?? 20;
        this.logger = Logger.resolve(options.debug);
        this.camera = new CameraManager({ maxEffects: this.maxCameraEffects });

        this._assets = options.assets ?? null;
        this._prefabs = options.assets?.prefabs as unknown as PrefabBucket3D ?? null;

        // Derive skinned-budget sizing from the bucket when present; explicit options win.
        const SKINNED_PARTS_PER_INSTANCE_DEFAULT_CAP = 3;

        const bucketStats = this._prefabs ? computeBucketStats(this._prefabs) : null;

        this.maxSkinnedInstances = options.maxSkinnedInstances
            ?? (bucketStats
                ? resolvedMaxInstances * Math.max(1, Math.min(bucketStats.maxSkinnedParts, SKINNED_PARTS_PER_INSTANCE_DEFAULT_CAP))
                : 5000);
        this.maxBonesPerSkin = options.maxBonesPerSkin
            ?? (bucketStats ? Math.max(1, bucketStats.maxJointCount) : 64);
        const cullDist = options.animationCullDistance ?? 50;
        this.skinCull = new SkinCull(this.core.frustum, cullDist);
        this.maxTotalBones = this.maxSkinnedInstances * this.maxBonesPerSkin * 2;

        const occlusionOptions = (options as WebGPU3DRendererOptions & {
            occlusion?: { enabled?: boolean; bias?: number; interval?: number };
        }).occlusion;
        this.occlusionInterval = Math.max(1, occlusionOptions?.interval ?? 15);
        this.occlusion = {
            enabled: occlusionOptions !== undefined && occlusionOptions.enabled !== false,
            bias: occlusionOptions?.bias ?? 0.005,
            stats: { batches: 0, candidates: 0 },
            readArgs: () => this.runtime.occlusion?.readArgs() ?? Promise.resolve(new Uint32Array(0)),
            readVisibility: () => this.runtime.occlusion?.readVisibility() ?? Promise.resolve({ static: new Uint32Array(0), skinned: new Uint32Array(0) }),
            isOccluded: (handle) => this.runtime.occlusion?.isOccluded(handle) ?? Promise.resolve(false),
            track: (handles) => {
                const tracker = new OcclusionTrackerImpl(handles, () => {
                    const i = this.occlusionTrackers.indexOf(tracker);
                    if (i >= 0) this.occlusionTrackers.splice(i, 1);
                });
                this.occlusionTrackers.push(tracker);
                return tracker;
            },
            update: () => this.updateOcclusionTracks(),
        };
    }

    async init(): Promise<void> {
        // Request the adapter ourselves so we can read its limits and forward
        // them as `requiredLimits` to the device. The defaults are very low
        // (128 MB max storage buffer); for skinned scenes the bone-matrix
        // buffer alone can exceed that at a few thousand instances. We pass
        // through the adapter's actual caps so users get the GPU's real budget.
        this.runtime = runtime();
        const presentation = await this.runtime.createPresentation(this.canvas);
        this.core.root = { device: presentation.device } as never;
        this.core.device = presentation.device;
        this.core.context = presentation.context;
        this.core.format = presentation.format;
        presentation.configure({ alphaMode: 'opaque' });
        this.core.context.configure({
            device: this.core.device,
            format: this.core.format,
            alphaMode: 'opaque',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.camera.setAspect(this.canvas.clientWidth || this._width, this.canvas.clientHeight || this._height);

        this.core.pipelines = new MeshPipelines();
        const rendererOptions = this.options as WebGPU3DRendererOptions;
        const maxLights = rendererOptions.maxLights ?? DEFAULT_CAPACITIES.lights;
        this.core.pipelines.build({
            runtime: this.runtime,
            root: this.core.root,
            device: this.core.device,
            format: this.core.format,
            maxInstances: this.maxInstances,
            maxSkinnedInstances: this.maxSkinnedInstances,
            maxTotalBones: this.maxTotalBones,
            maxLights,
            width: this._width,
            height: this._height,
        });
        this.core.scene = new SceneUniforms(this.core.device, this.core.pipelines.rawUniformBuffer, this.core.uniformData);


        this.cameraEffects = new CameraEffectStack({ root: this.core.root, format: this.core.format, maxEffects: this.maxCameraEffects, runtime: this.runtime });
        this.runtime.occlusion?.setDepth(this.core.pipelines.depthTexture);
        this.cameraEffects.setDepth(this.core.pipelines.depthTexture.createView(), this.core.pipelines.depthSampler, this.camera.near, this.camera.far);

        const managers = new RendererManagers({
            runtime: this.runtime, core: this.core, logger: this.logger, options: this.options,
            camera: this.camera, skinCull: this.skinCull, maxInstances: this.maxInstances,
            maxSkinnedInstances: this.maxSkinnedInstances, maxTotalBones: this.maxTotalBones,
            canvas: this.canvas, assets: this._assets, prefabs: this._prefabs,
            elapsed: () => this.elapsed, nextDecalSeq: () => this.decalMaterialSeq++,
        });
        this.animation = managers.animation; this.materials = managers.materials; this.lights = managers.lights;
        this.particles = managers.particles; this.models = managers.models; this.instances = managers.instances;
        // GPU geomorph: blend adjacent LOD levels over ~8 ticks (set 0 to hard-switch).
        this.instances.lodFadeTicks = 8;

        // Models must exist before the occlusion port reads their bounds.
        if (this._prefabs) { await this.models.upload(this._assets!); }

        // Build the occlusion port once the depth + instance buffers exist.
        if (this.occlusion.enabled && this.runtime.occlusion === undefined) {
            // Capacity-sized so models added later (async glTF uploads) fit;
            // repopulated every frame from the live model list.
            const modelBounds = this.core.device.createBuffer({
                size: this.modelBoundsCapacity * 8 * 4,
                usage: RawBufferUsage.STORAGE | RawBufferUsage.COPY_DST | RawBufferUsage.COPY_SRC,
            });
            this.modelBoundsBuffer = modelBounds;
            this.updateModelBounds();
            // Sized to the full MeshUniforms struct the cull binds (only the
            // leading mat4 is written; the rest is uniform padding).
            this.occlusionVp = this.runtime.createRawBuffer(d.arrayOf(d.f32, 40), 'uniform');
            (this.runtime as { occlusion?: import('murow/renderer/managers').RendererRuntime['occlusion'] }).occlusion = createOcclusion(
                { device: this.core.device },
                {
                    depthTexture: this.core.pipelines.depthTexture,
                    depthSampler: this.core.pipelines.depthSampler,
                    dynamicBuffer: this.core.pipelines.rawDynamicBuffer,
                    staticBuffer: this.core.pipelines.rawStaticBuffer,
                    modelBounds,
                    viewProjection: this.occlusionVp,
                    occlusionBuffer: this.core.pipelines.rawSkinnedOcclusionBuffer,
                    maxInstances: this.maxInstances,
                    maxBatches: this.maxInstances,
                },
            );
            this.runtime.occlusion?.configure({ maxBatches: this.maxInstances, maxInstances: this.maxInstances });
            this.updateModelBounds();
            this.runtime.occlusion?.setDepth(this.core.pipelines.depthTexture);
        }
        this.shadows = managers.shadows; this.decals = managers.decals; this.mainPass = managers.mainPass;
        this.raycast = managers.raycast; this.interpolators = managers.interpolators as never;

        this.hitboxDebug.init(this.runtime, this.core.device, this.core.format);
        this.resize = new ResizeController(
            this.canvas,
            (w, h, cssW, cssH) => this.applyResize(w, h, cssW, cssH),
            undefined,
            (this.options as WebGPU3DRendererOptions).maxPixelRatio ?? Infinity,
        );
        this.resize.start(this._width, this._height);
        this._initialized = true;
    }

    // textures upload/sampling lives in ./textures (TextureRegistry).

    private applyResize(w: number, h: number, cssW: number, cssH: number): void {
        this._width = w;
        this._height = h;

        if (this.options.autoResize) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.core.context.configure({
                device: this.core.device,
                format: this.core.format,
                alphaMode: 'opaque',
            });
        }

        this.camera.setAspect(cssW, cssH);

        this.core.pipelines.resizeDepth(w, h);
        if (this.cameraEffects) {
            this.runtime.occlusion?.setDepth(this.core.pipelines.depthTexture);
        this.cameraEffects.setDepth(this.core.pipelines.depthTexture.createView(), this.core.pipelines.depthSampler, this.camera.near, this.camera.far);
        }
    }

    /**
     * Register a callback that fires when the canvas resizes.
     * Receives the new width and height in physical pixels.
     */
    onResize(callback: (width: number, height: number) => void): void {
        this.resize.onResize(callback);
    }

    /**
     * Set the maximum distance (in world units) at which the renderer keeps
     * computing skeletal animation. Skinned instances farther than this are
     * still drawn, but with their last-computed bone matrices instead of
     * fresh ones, which saves GPU compute work. Their internal animation
     * clocks keep ticking on CPU, so when they come back into range they
     * resume in sync.
     *
     * Lower values trade visual smoothness on distant characters for FPS.
     * Pass `Infinity` to disable culling entirely (always animate).
     *
     * Safe to call any time; takes effect on the next frame.
     *
     * @param distance Max distance to animate at, in world units.
     */
    setAnimationCullDistance(distance: number): void {
        this.skinCull.setDistance(distance);
    }

    /** Current animation cull distance (in world units). See `setAnimationCullDistance`. */
    get animationCullDistance(): number {
        return this.skinCull.distance;
    }

    /**
     * Max skinned instances the renderer was sized for at construction.
     * Independent budget from `maxInstances` since skinned characters use a
     * separate set of GPU buffers. Read-only.
     */
    get maxSkinned(): number {
        return this.maxSkinnedInstances;
    }

    /** Number of live dynamic lights. */
    get lightCount(): number {
        return this.lights.count;
    }

    /**
     * Project a world point to canvas CSS pixels (for HTML overlays like
     * nameplates/damage numbers). Writes `[x, y, w]` into `out` (CSS px + clip
     * w) and returns `false` when the point is behind the camera. Zero-alloc.
     */
    worldToScreen(x: number, y: number, z: number, out: Float32Array): boolean {
        const m = this.camera.getViewProjectionMatrix();
        const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
        if (cw <= 0) { out[0] = 0; out[1] = 0; out[2] = 0; return false; }
        const w = this.canvas.clientWidth || this._width;
        const h = this.canvas.clientHeight || this._height;
        out[0] = (cx / cw * 0.5 + 0.5) * w;
        out[1] = (0.5 - cy / cw * 0.5) * h;
        out[2] = cw;
        return true;
    }


    /** Spawn a mesh instance. Sugar over `instances.add`. */
    addInstance(options: any): any { return this.instances.add(options); }

    /** Compile a material from a spec. Sugar over `materials.create`. */
    createMaterial(spec: any): any { return this.materials.create(spec); }

    /** Set the global ambient term. Sugar over `lights.ambient`. */
    setAmbient(color: readonly [number, number, number]): void { this.lights.ambient(color); }

    /** Set the directional ("sun") light. Sugar over `lights.sun`. */
    setDirectionalLight(direction: readonly [number, number, number], color: readonly [number, number, number] = [1, 1, 1], intensity = 1): void {
        this.lights.sun(direction, color, intensity);
    }

    storePreviousState(): void {
        for (let i = 0; i < this.interpolators.length; i++) {
            this.interpolators[i]!.storePrevious();
        }
        // LOD is a per-tick decision (stable, runs once per tick not per frame);
        // the render path only draws whatever level was selected.
        const cam = this.camera.position;
        this.instances.selectLod(
            cam[0], cam[1], cam[2],
            this.camera.lodBias, this.instances.lodHysteresis, this.camera.lodEnabled,
        );
        // Refresh tracked occlusion on a tick counter, like LOD. The readback is
        // fire-and-forget: the flags land on the microtask queue, never blocking
        // the tick, and it is skipped while a previous readback is still in flight.
        this.occlusion.update();
    }

    private updateOcclusionTracks(): void {
        if (this.occlusionTrackers.length === 0) return;
        if (++this.occlusionTicks < this.occlusionInterval) return;
        this.occlusionTicks = 0;
        if (this.occlusionPending) return;
        const port = this.runtime?.occlusion;
        if (!port || !this.occlusion.enabled) return;
        this.occlusionPending = true;
        port.readVisibility().then(
            (vis) => {
                for (let i = 0; i < this.occlusionTrackers.length; i++) this.occlusionTrackers[i]!.apply(vis);
                this.occlusionPending = false;
            },
            () => { this.occlusionPending = false; },
        );
    }

    render(alpha: number): void {
        if (!this._initialized) return;

        const frameDelta = this.advanceFrame();
        this.camera.interpolate(alpha);

        const vpMatrix = this.camera.getViewProjectionMatrix();
        this.core.frustum.setFromViewProjection(vpMatrix);
        // Off-screen emitters skip spawning (their live particles still finish).
        this.particles.setCullFrustum(this.core.frustum);

        this.uploadInstanceBuffers();

        // Flush queued particle spawns and advance the pool once per frame.
        this.particles.simulate(frameDelta);

        const swapchainView = this.core.context.getCurrentTexture().createView();
        const enabledEffects = this.camera.effects.enableCount();
        const targetView = enabledEffects > 0 ? this.cameraEffects.sceneTarget(this._width, this._height) : swapchainView;
        const encoder = this.core.device.createCommandEncoder();

        // Occlusion is optional: the port may be absent or disabled.
        const occ = this.occlusion.enabled ? this.runtime.occlusion : undefined;
        const occlusionCandidates = occ
            ? (this.instances.store.slotIndexBuffer ?? this.core.pipelines.rawSlotIndexBuffer)
            : null;
        const occlusionActive = occ !== undefined && occlusionCandidates !== null;

        // Shadow passes run first, then the main mesh pass, then particles/post.
        this.renderShadowPasses(encoder);
        this.uploadLightsAndUniforms(alpha, vpMatrix);

        // Cull candidates against the pyramid built from last frame's depth.
        if (occlusionActive) {
            // Project with the camera the pyramid was built with (last frame).
            if (this.occlusionVp) this.core.device.queue.writeBuffer(this.occlusionVp, 0, this.prevVp);
            (occ as { bias?: number }).bias = this.occlusion.bias;
            occ!.cull(encoder, occlusionCandidates!, this.instances.occlusionBatches);
            // Skinned instances: cull against their own buffers and clear the
            // per-slot visibility the skinned vertex shader reads.
            if (this.instances.skinnedOcclusionBatchCount > 0) {
                occ!.cull(
                    encoder,
                    this.core.pipelines.rawSkinnedSlotIndexBuffer,
                    this.instances.skinnedOcclusionBatches,
                    this.core.pipelines.rawSkinnedDynamicBuffer,
                    this.core.pipelines.rawSkinnedStaticBuffer,
                    true,
                );
            }
        }
        let candidateTotal = 0;
        for (let i = 0; i < this.instances.occlusionBatchCount; i++) {
            candidateTotal += this.instances.occlusionBatches[i]!.candidateCount;
        }
        this.occlusion.stats.batches = occlusionActive ? this.instances.occlusionBatchCount : 0;
        this.occlusion.stats.candidates = occlusionActive ? candidateTotal : 0;

        // The mesh pipelines switch to indirect draws while occlusion is active.
        const pipelines = this.core.pipelines as MeshPipelines & {
            indirectEnabled?: boolean;
            rawIndirectArgsBuffer?: RawBuffer | null;
        };
        pipelines.indirectEnabled = occlusionActive;
        if (occlusionActive) pipelines.rawIndirectArgsBuffer = occ!.indirectArgs ?? null;

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: {
                    r: this._clearColor[0], g: this._clearColor[1],
                    b: this._clearColor[2], a: this._clearColor[3],
                },
            }],
            depthStencilAttachment: {
                view: this.core.pipelines.depthTexture.createView(),
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 1.0,
            },
        });

        this.renderMainPass(pass, vpMatrix);
        this.renderParticles(pass, vpMatrix);
        pass.end();

        // Build this frame's pyramid from the opaque depth written by the pass.
        if (occlusionActive) occ!.buildPyramid(encoder);

        this.renderPost(encoder, swapchainView, enabledEffects);

        this.core.device.queue.submit([encoder.finish()]);
        // Remember this frame's camera for next frame's cull.
        this.prevVp.set(vpMatrix);
    }

    /** Advance the render clock and skeletal animations; returns the frame delta. */
    private advanceFrame(): number {
        const now = performance.now();
        let frameDelta = 0;
        if (this.lastRenderTime > 0) {
            frameDelta = (now - this.lastRenderTime) / 1000;
            this.elapsed += frameDelta;
            this.animation.update(frameDelta);
        }
        this.lastRenderTime = now;
        return frameDelta;
    }

    /** Refresh the per-model bounds the occlusion cull reads (models can load late). */
    private updateModelBounds(): void {
        const buf = this.modelBoundsBuffer;
        if (!buf) return;
        const models = this.core.models.models;
        const n = Math.min(models.length, this.modelBoundsCapacity);
        if (this.boundsScratch === null || this.boundsScratch.length < n * 8) {
            this.boundsScratch = new Float32Array(Math.max(n, 1) * 8);
        }
        const bd = this.boundsScratch;
        for (let i = 0; i < n; i++) {
            const m = models[i]!;
            bd[i * 8] = m.halfX;
            bd[i * 8 + 1] = m.halfY;
            bd[i * 8 + 2] = m.halfZ;
            bd[i * 8 + 4] = m.centerX;
            bd[i * 8 + 5] = m.centerY;
            bd[i * 8 + 6] = m.centerZ;
        }
        (this.runtime.occlusion as any)?.writeModelBounds?.(bd, n);
    }

    /** Upload instance transforms and bone matrices for the frame's packed batches. */
    private uploadInstanceBuffers(): void {
        this.updateModelBounds();
        // Pick a level per LOD instance from the (interpolated) camera before culling.
        // Gather, cull and pack the visible batch lists into the manager.
        this.instances.prepareFrame(this.core.frustum);

        // Upload dynamic data
        this.core.device.queue.writeBuffer(
            this.core.pipelines.rawDynamicBuffer, 0,
            this.instances.store.dynamicData.buffer, this.instances.store.dynamicData.byteOffset, this.instances.store.dynamicData.byteLength,
        );

        // Upload static data
        if (this.instances.store.staticDirty) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawStaticBuffer, 0,
                this.instances.store.staticData.buffer, this.instances.store.staticData.byteOffset, this.instances.store.staticData.byteLength,
            );
            this.instances.store.staticDirty = false;
        }

        if (this.instances.slotIndexCount > 0) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawSlotIndexBuffer, 0,
                this.instances.store.slotIndexData.buffer, this.instances.store.slotIndexData.byteOffset,
                this.instances.slotIndexCount * 4,
            );
        }

        // --- Upload skinned buffers ---
        this.core.device.queue.writeBuffer(
            this.core.pipelines.rawSkinnedDynamicBuffer, 0,
            this.instances.skinnedStore.dynamicData.buffer, this.instances.skinnedStore.dynamicData.byteOffset, this.instances.skinnedStore.dynamicData.byteLength,
        );

        // Always upload the skinned static data: the bounds cull reads it and a
        // missed dirty flip leaves the buffer zeroed.
        this.core.device.queue.writeBuffer(
            this.core.pipelines.rawSkinnedStaticBuffer, 0,
            this.instances.skinnedStore.staticData.buffer, this.instances.skinnedStore.staticData.byteOffset, this.instances.skinnedStore.staticData.byteLength,
        );
        this.instances.skinnedStore.staticDirty = false;

        // Upload bone matrices from CPU only if GPU compute is not active
        this.animation.flushBoneMatrices();

        if (this.instances.skinnedSlotIndexCount > 0) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawSkinnedSlotIndexBuffer, 0,
                this.instances.skinnedStore.slotIndexData.buffer, this.instances.skinnedStore.slotIndexData.byteOffset,
                this.instances.skinnedSlotIndexCount * 4,
            );
        }

        // (Skinned slot visibility is reset to 1 by the occlusion cull pass; the
        // cull clears the slots it rejects and the vertex shader collapses a 0.)
    }

    /** Delegate each shadow pass to its manager (caster gather plus encode). */
    private renderShadowPasses(encoder: RawCommandEncoder): void {
        this.shadows.directional.render(encoder);
        this.shadows.spot.render(encoder);
        this.shadows.point.render(encoder);
    }

    /** Pack the light buffer and write the frame uniforms. Runs after the light assignments. */
    private uploadLightsAndUniforms(alpha: number, vpMatrix: Float32Array): void {
        this.lights.upload(
            this.core.device,
            this.core.pipelines.rawLightBuffer,
            this.core.uniformData,
            MESH_UNIFORM_LIGHT_OFFSET,
        );
        this.core.scene.write({
            vpMatrix,
            alpha,
            time: this.elapsed,
            cameraPos: this.camera.position,
            width: this._width,
            height: this._height,
        });
    }

    /** Draw the batched non-skinned and skinned meshes, then debug hitboxes. */
    private renderMainPass(pass: RawRenderPassEncoder, vpMatrix: Float32Array): void {
        this.mainPass.record(pass);
        if (this.debug.hitboxes && this._prefabs) {
            this.hitboxDebug.drawInstances(pass, vpMatrix, this.instances, this.raycast.state);
        }
    }

    /** Draw the particle systems into the current pass. */
    private renderParticles(pass: RawRenderPassEncoder, vpMatrix: Float32Array): void {
        cameraBasis(this.camera.position, this.camera.target, this.camera.up, this._camRight, this._camUp);
        this.particles.draw(pass, vpMatrix, this._camRight, this._camUp);
    }

    /** Apply the enabled camera effects into the swapchain. */
    private renderPost(encoder: RawCommandEncoder, swapchainView: GPUTextureView, enabledEffects: number): void {
        if (enabledEffects > 0) {
            this.cameraEffects.apply(encoder, swapchainView as never, this.camera.effects, this.elapsed, this._width, this._height);
        }
    }

    // Visibility + skinning culling lives in ./cull (Frustum, SkinCull).

    destroy(): void {
        this.resize?.disconnect();
        this.runtime?.occlusion?.destroy();
        // Detach from the bucket so it doesn't retain this dead renderer via the coordinator's closure.
        this.animation?.dispose();
        this.cameraEffects?.destroy();
        this.particles?.destroy();
        this.particles?.system.destroy();
        this.core.pipelines?.destroy();
        this.core.models?.destroy();
    }
}

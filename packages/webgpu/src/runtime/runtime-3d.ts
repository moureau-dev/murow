import type { RawCommandEncoder, RawRenderPassEncoder } from 'murow/gpu';
/**
 * WebGPU3DRenderer — instanced 3D mesh renderer backed by TypeGPU.
 *
 * - One draw call per model type (all instances batched)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation + TRS transform in vertex shader
 * - GPU index buffer for sparse instancing
 * - Depth testing + back-face culling
 */
type GpuDeviceRef = { device: GPUDevice };
type AnyField = import('murow/gpu/schema').Field<any, any> | import('murow/gpu/schema').GpuStruct;
import { Base3DRenderer } from 'murow/renderer';
import { webgpuRuntime } from '../webgpu-runtime';
import { MESH_UNIFORM_LIGHT_OFFSET } from 'murow/renderer/managers/runtime';
import { Logger } from 'murow/core';
import {
    type AssetBucket,
    type PrefabBucket3D,
    type PlayOptions,
} from 'murow/renderer';
import {
    InstanceManager,
    InstanceStore,
    SkinnedInstanceStore,
    MaterialManager,
    MaterialLibrary,
    type MaterialSpec,
    LightManager,
    LightSystem,
    ShadowManager,
    ShadowSystem,
    SpotShadowSystem,
    PointShadowSystem,
    DecalManager,
    ParticleManager,
    ParticleSystem3D,
    CameraManager,
    ModelsManager,
} from 'murow/renderer/managers/runtime';
import { RendererManagers } from 'murow/renderer/managers';
import type { RendererRuntime } from 'murow/renderer/managers';
import { CameraEffectStack } from 'murow/renderer/managers/runtime';
import {
    TextureRegistry,
    ResizeController,
    RaycastController,
    WebGPURaycast3D,
    MeshPipelines,
    SkeletalRuntime,
    ModelLibrary,
    SkinCull,
} from 'murow/renderer/managers/runtime';
import { RendererCore, SceneUniforms } from 'murow/renderer/managers/runtime';
import { MainPass } from 'murow/renderer/managers/runtime';
import { HitboxDebugRenderer } from 'murow/renderer/managers/runtime';
import { MAX_LIGHTS } from 'murow/renderer/managers/runtime';
import { DEFAULT_CAPACITIES } from 'murow/renderer/managers/runtime';
import type {
    Interpolator,
    ModelData,
    ModelHandle,
    GltfModel,
    MeshInstanceHandle,
    InstanceHandle,
    LightHandle,
    MeshInstanceOptions,
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

/** The WebGPU 3D renderer: instances, materials, lights, skinning, and camera effects. */
export class WebGPU3DRenderer<A extends AssetBucket<'3d', any, any> = AssetBucket<'3d', any, any>> extends Base3DRenderer {
    private core!: RendererCore;
    private resize!: ResizeController;

    private readonly maxTotalBones: number;

    // Skeletal animation runtime (clip packing, compute kernel, bone buffer).
    private animation!: SkeletalRuntime;

    private readonly maxSkinnedInstances: number;
    private readonly maxBonesPerSkin: number;

    private readonly skinCull: SkinCull;

    readonly camera: CameraManager;
    raycast!: WebGPURaycast3D;
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
    }

    async init(): Promise<void> {
        // Request the adapter ourselves so we can read its limits and forward
        // them as `requiredLimits` to the device. The defaults are very low
        // (128 MB max storage buffer); for skinned scenes the bone-matrix
        // buffer alone can exceed that at a few thousand instances. We pass
        // through the adapter's actual caps so users get the GPU's real budget.
        this.runtime = webgpuRuntime();
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
        this.shadows = managers.shadows; this.decals = managers.decals; this.mainPass = managers.mainPass;
        this.raycast = managers.raycast; this.interpolators = managers.interpolators as never;
        if (this._prefabs) { await this.models.upload(this._assets!); }

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

        // Shadow passes run first, then the main mesh pass, then particles/post.
        this.renderShadowPasses(encoder);
        this.uploadLightsAndUniforms(alpha, vpMatrix);

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

        this.renderPost(encoder, swapchainView, enabledEffects);

        this.core.device.queue.submit([encoder.finish()]);
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

    /** Upload instance transforms and bone matrices for the frame's packed batches. */
    private uploadInstanceBuffers(): void {
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

        if (this.instances.skinnedStore.staticDirty) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawSkinnedStaticBuffer, 0,
                this.instances.skinnedStore.staticData.buffer, this.instances.skinnedStore.staticData.byteOffset, this.instances.skinnedStore.staticData.byteLength,
            );
            this.instances.skinnedStore.staticDirty = false;
        }

        // Upload bone matrices from CPU only if GPU compute is not active
        this.animation.flushBoneMatrices();

        if (this.instances.skinnedSlotIndexCount > 0) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawSkinnedSlotIndexBuffer, 0,
                this.instances.skinnedStore.slotIndexData.buffer, this.instances.skinnedStore.slotIndexData.byteOffset,
                this.instances.skinnedSlotIndexCount * 4,
            );
        }
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
        // Detach from the bucket so it doesn't retain this dead renderer via the coordinator's closure.
        this.animation?.dispose();
        this.cameraEffects?.destroy();
        this.particles?.destroy();
        this.particles?.system.destroy();
        this.core.pipelines?.destroy();
        this.core.models?.destroy();
    }
}

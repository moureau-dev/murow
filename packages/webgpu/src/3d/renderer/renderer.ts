/**
 * WebGPU3DRenderer — instanced 3D mesh renderer backed by TypeGPU.
 *
 * - One draw call per model type (all instances batched)
 * - Zero-GC: flat Float32Array CPU buffers, raw writeBuffer uploads
 * - GPU-side interpolation + TRS transform in vertex shader
 * - GPU index buffer for sparse instancing
 * - Depth testing + back-face culling
 */
import type { TgpuRoot } from 'typegpu';
import type { AnyWgslData } from 'typegpu/data';
import { Base3DRenderer } from 'murow/renderer';
import { tgpu } from '../../shaders/typegpu';
import { ComputeBuilder, type ComputeOptions } from '../../compute/compute-builder';
import {
    DYNAMIC_MESH_FLOATS,
    STATIC_MESH_FLOATS,
    SKINNED_STATIC_MESH_FLOATS,
    MESH_UNIFORM_ALPHA_OFFSET,
    MESH_UNIFORM_LIGHT_OFFSET,
    MESH_UNIFORM_CAMERA_OFFSET,
    MESH_UNIFORM_TIME_OFFSET,
    MESH_UNIFORM_RESOLUTION_OFFSET,
    MESH_UNIFORM_FLOATS,
} from '../../core/types';
import { LightSystem, type LightSpec } from './lights';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import { MaterialLibrary, type MaterialHandle } from './materials';
import type { MaterialSpec } from './materials/specs';
import { Camera3D } from '../../camera/camera-3d';
import { CameraEffectStack } from './camera-effects/stack';
import { Logger } from 'murow/core';
import { ParticleSystem3D } from '../particles/particle-system-3d';
import { TextureRegistry } from './textures';
import { ResizeController } from './resize';
import { RaycastController } from './raycast';
import { InstanceStore, SkinnedInstanceStore, type SkinModelLike } from './instances';
import { MeshPipelines } from './pipelines';
import { SkeletalRuntime } from './animation';
import { ModelLibrary } from './models';
import {
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    STAT_SX, STAT_SY, STAT_SZ,
    SSTAT_SX, SSTAT_SY, SSTAT_SZ,
} from './instances/offsets';
import { MAX_LIGHTS } from '../shader';
import {
    type ParsedGltf,
    type AssetBucket,
    type PrefabBucket3D,
    type Prefab3D,
    type CompositePrefab,
    type ConePrefab,
    type CubePrefab,
    type CylinderPrefab,
    type MeshPrefab,
    type PlanePrefab,
    type SpherePrefab,
    type TexturePrefab,
    type PlayOptions,
} from 'murow/renderer';
import { type Hitbox } from 'murow/core/hitbox';
import { WebGPURaycast3D, type RaycastState } from './raycast';
import { HitboxDebugRenderer } from '../hitbox';
import { Frustum } from './cull/frustum';
import { SkinCull } from './cull/skin-cull';
import type {
    ModelData,
    ModelHandle,
    GltfModel,
    MeshInstanceHandle,
    InstanceHandle,
    LightHandle,
    MeshInstanceOptions,
    WebGPU3DRendererOptions,
} from './types';
import type { CubeUvMode } from 'murow/renderer';
/**
 * Per-prefab GPU handle, populated by the renderer at `init()` time when a
 * PrefabBucket is supplied.
 */
const GPU_HANDLE = Symbol('murow.gpuHandle');

/** True iff value is a Prefab3D (returned from `bucket.get(...)`). */
function isPrefab3D(value: ModelHandle | GltfModel | Prefab3D | string): value is Prefab3D {
    if (typeof value === 'string' || value === undefined) return false;
    const t = (value as Prefab3D).type;
    return t === 'gltf' || t === 'grid' || t === 'cube' || t === 'composite' || t === 'plane';
}

function setPrefabHandle(prefab: Prefab3D, handle: ModelHandle | GltfModel): void {
    (prefab as unknown as Record<symbol, ModelHandle | GltfModel>)[GPU_HANDLE] = handle;
}

/**
 * Look up the GPU handle attached to a prefab by its renderer. Used by
 * `addInstance({ model: bucket.get('foo') })` to resolve the prefab back to
 * the renderer's internal handle. Throws if the prefab hasn't been uploaded yet.
 */
function resolvePrefabHandle(prefab: Prefab3D): ModelHandle | GltfModel {
    const h = (prefab as unknown as Record<symbol, ModelHandle | GltfModel>)[GPU_HANDLE];
    if (!h) {
        throw new Error(
            `Prefab '${prefab.id}' has no GPU handle — has the renderer's init() been called with this bucket?`,
        );
    }
    return h;
}

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
    private root!: TgpuRoot;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private resize!: ResizeController;
    private raycastController!: RaycastController;
    private format!: GPUTextureFormat;

    // Non-skinned instance pool (dense arrays, FreeList, SparseBatcher).
    private instances!: InstanceStore;
    private nextInstanceId = 0;

    // Raw GPU resources (layouts, buffers, pipelines, bind groups, depth).
    private pipelines!: MeshPipelines;

    // GPU texture registry.
    private textures!: TextureRegistry;

    // GPU mesh registry (primitives + glTF uploads).
    private models!: ModelLibrary;

    private readonly maxTotalBones: number;

    // Skeletal animation runtime (clip packing, compute kernel, bone buffer).
    private animation!: SkeletalRuntime;

    // Skinned instance pool (dense arrays, bone-offset pool, anim states).
    private skinned!: SkinnedInstanceStore;
    private readonly maxSkinnedInstances: number;
    private readonly maxBonesPerSkin: number;

    private readonly frustum = new Frustum();
    private readonly skinCull: SkinCull;

    // Dynamic lights — CPU state (SoA, slots, globals) lives in LightSystem;
    // the renderer owns only the GPU buffer it packs into each frame.
    private lights = new LightSystem(MAX_LIGHTS);
    private materials!: MaterialLibrary;

    readonly camera: Camera3D;
    readonly raycast: WebGPURaycast3D;
    private uniformData = new Float32Array(MESH_UNIFORM_FLOATS);
    private lastRenderTime = 0;
    /** Accumulated render time (seconds), exposed to shaders as `scene.time`. */
    private elapsed = 0;
    private cameraEffects!: CameraEffectStack;
    private readonly maxCameraEffects: number;
    private readonly logger: Logger;
    private readonly _camRight = new Float32Array(3);
    private readonly _camUp = new Float32Array(3);
    /** GPU particle system. Add emitters via `renderer.particles.addEmitter(...)`. */
    particles!: ParticleSystem3D;

    private readonly _assets: AssetBucket<'3d', any, any> | null;
    private readonly _prefabs: PrefabBucket3D | null;

    debug: { hitboxes: boolean } = { hitboxes: false };

    private hitboxDebug = new HitboxDebugRenderer();

    constructor(canvas: HTMLCanvasElement, options: WebGPU3DRendererOptions<A>) {
        // Resolve maxInstances from the bucket before delegating to super:
        // default to `bucket.size + slack` so non-skinned prefabs (grids, primitives)
        // always have room without the user having to count them by hand.
        const resolvedMaxInstances = options.maxInstances
            ?? (options.assets ? options.assets.prefabs.size + 16 : 32);
        super(canvas, { ...options, maxInstances: resolvedMaxInstances });
        this.maxCameraEffects = options.maxCameraEffects ?? 20;
        this.logger = Logger.resolve(options.debug);
        this.camera = new Camera3D({ maxEffects: this.maxCameraEffects });
        this.raycastController = new RaycastController({
            camera: this.camera,
            eachInstance: (visit) => this.eachInstance(visit),
            resolveHitbox: (handle) => this.resolveHitbox(handle),
        });
        this.raycast = new WebGPURaycast3D(this);

        this._assets = options.assets ?? null;
        this._prefabs = options.assets?.prefabs as unknown as PrefabBucket3D ?? null;

        // Derive skinned-budget sizing from the bucket when present; explicit options win.
        //
        // The auto-sized formula is `maxInstances * parts * bonesPerSkin * 128 bytes` which
        // explodes for rigs with many parts (a 14-part, 70-bone prefab at 2000 instances
        // would need ~478 MB, past WebGPU's default 256 MB buffer cap). The bone buffer is a
        // shared pool, not per-instance, so we cap the per-instance parts dimension; the bones
        // dimension must fit the largest rig in the bucket or vertices weighted to clipped
        // joints render as garbage. Pass explicit `maxSkinnedInstances`/`maxBonesPerSkin` to
        // override when needed.
        const SKINNED_PARTS_PER_INSTANCE_DEFAULT_CAP = 3;

        const bucketStats = this._prefabs ? computeBucketStats(this._prefabs) : null;

        this.maxSkinnedInstances = options.maxSkinnedInstances
            ?? (bucketStats
                ? resolvedMaxInstances * Math.max(1, Math.min(bucketStats.maxSkinnedParts, SKINNED_PARTS_PER_INSTANCE_DEFAULT_CAP))
                : 5000);
        this.maxBonesPerSkin = options.maxBonesPerSkin
            ?? (bucketStats ? Math.max(1, bucketStats.maxJointCount) : 64);
        const cullDist = options.animationCullDistance ?? 50;
        this.skinCull = new SkinCull(this.frustum, cullDist);
        this.maxTotalBones = this.maxSkinnedInstances * this.maxBonesPerSkin * 2;

        // Non-skinned instance pool
        this.instances = new InstanceStore({
            maxInstances: resolvedMaxInstances,
            getTextureBindGroup: (id) => this.textures.get(id)?.bindGroup,
        });

        // Skinned instance pool
        const msi = this.maxSkinnedInstances;
        this.skinned = new SkinnedInstanceStore({
            maxSkinnedInstances: msi,
            maxTotalBones: this.maxTotalBones,
            maxSkins: this._prefabs ? this._prefabs.size : 64,
            uploadRestPose: (skinModel, boneOffset, jointCount) => this.animation.writeRestPose(skinModel, boneOffset, jointCount),
            getTextureBindGroup: (id) => this.textures.get(id)?.bindGroup,
        });
    }

    async init(): Promise<void> {
        // Request the adapter ourselves so we can read its limits and forward
        // them as `requiredLimits` to the device. The defaults are very low
        // (128 MB max storage buffer); for skinned scenes the bone-matrix
        // buffer alone can exceed that at a few thousand instances. We pass
        // through the adapter's actual caps so users get the GPU's real budget.
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('WebGPU3DRenderer: no GPU adapter available');
        const a = adapter.limits;
        const requiredLimits: Record<string, number> = {
            maxBufferSize: a.maxBufferSize,
            maxStorageBufferBindingSize: a.maxStorageBufferBindingSize,
            maxStorageBuffersPerShaderStage: a.maxStorageBuffersPerShaderStage,
            maxComputeWorkgroupStorageSize: a.maxComputeWorkgroupStorageSize,
            maxComputeInvocationsPerWorkgroup: a.maxComputeInvocationsPerWorkgroup,
        };
        const device = await adapter.requestDevice({ requiredLimits });
        this.root = tgpu.initFromDevice({ device });
        this.device = this.root.device;

        this.context = this.canvas.getContext('webgpu')!;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'opaque',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.camera.setAspect(this.canvas.clientWidth || this._width, this.canvas.clientHeight || this._height);

        this.pipelines = new MeshPipelines();
        this.pipelines.build({
            root: this.root,
            device: this.device,
            format: this.format,
            maxInstances: this.maxInstances,
            maxSkinnedInstances: this.maxSkinnedInstances,
            maxTotalBones: this.maxTotalBones,
            width: this._width,
            height: this._height,
        });

        this.cameraEffects = new CameraEffectStack({ root: this.root, format: this.format, maxEffects: this.maxCameraEffects });
        this.cameraEffects.setDepth(this.pipelines.depthTexture.createView(), this.pipelines.depthSampler, this.camera.near, this.camera.far);

        this.textures = new TextureRegistry(this.device, this.pipelines.rawTexturedPipeline.getBindGroupLayout(1));
        this.textures.initWhiteFallback();
        if (this._assets) {
            // The bucket accessor proxy binds methods per access; capture it once.
            const findTexture = this._assets.textures.find;
            this.textures.setResolver((id) => findTexture(id));
        }

        const particleOptions = this.options as WebGPU3DRendererOptions;
        this.particles = new ParticleSystem3D({
            root: this.root,
            format: this.format,
            maxParticles: particleOptions.maxParticles ?? 4096,
            maxMaterials: particleOptions.maxParticleMaterials ?? 16,
            maxEmitters: particleOptions.maxParticleEmitters ?? 64,
            resolveTexture: (id) => this.textures.get(id),
            logger: this.logger,
        });

        this.materials = new MaterialLibrary({
            root: this.root,
            device: this.device,
            pipelines: this.pipelines,
            textures: this.textures,
            meshLayout: this.pipelines.meshLayout,
            maxMaterials: (this.options as WebGPU3DRendererOptions).maxMaterials ?? 64,
        });

        this.animation = new SkeletalRuntime({
            root: this.root,
            device: this.device,
            pipelines: this.pipelines,
            skinned: this.skinned,
            camera: this.camera,
            skinCull: this.skinCull,
            maxSkinnedInstances: this.maxSkinnedInstances,
            maxTotalBones: this.maxTotalBones,
            maxSkins: this._prefabs ? this._prefabs.size : 64,
            getModel: (id) => this.models.get(id),
            getSkinModel: (i) => this.models.skinnedModel(i),
            skinnedModelCount: () => this.models.skinnedModelCount(),
        });

        this.models = new ModelLibrary({
            device: this.device,
            pipelines: this.pipelines,
            textures: this.textures,
            onSkinLoaded: (skinData, animClips) => this.animation.addSkin(skinData, animClips),
        });

        if (this._prefabs) {
            await this.uploadPrefabBucket(this._assets!);
        }

        this.hitboxDebug.init(this.device, this.format);
        this.resize = new ResizeController(this.canvas, (w, h, cssW, cssH) => this.applyResize(w, h, cssW, cssH));
        this.resize.start(this._width, this._height);
        this._initialized = true;
    }

    /**
     * Upload every prefab in the bucket to the GPU and stash the handle on
     * each prefab so `bucket.get(id)` resolves to a usable model. Also
     * subscribes the resync coordinator to the bucket's `clips-changed`
     * channel for lazy load/unload.
     */
    private async uploadPrefabBucket(assets: AssetBucket<'3d', any, any>): Promise<void> {
        const bucket = assets.prefabs as unknown as PrefabBucket3D;
        this.animation.attachBucket(bucket);

        // Upload textures from the asset's texture bucket
        // Must await all texture uploads so createPlane() finds them in gpuTextures.
        const texturePromises: Promise<void>[] = [];
        for (const prefab of assets.textures.entries()) {
            if (prefab.type === 'texture') {
                texturePromises.push(this.textures.upload(prefab as TexturePrefab));
            }
        }
        await Promise.all(texturePromises);

        for (const prefab of bucket.entries()) {
            if (prefab.type === 'gltf') {
                const beforeSkinCount = this.models.skinnedModelCount();
                const model = this.uploadParsedGltf(prefab.parsed);
                setPrefabHandle(prefab, model);
                if (this.models.skinnedModelCount() > beforeSkinCount) {
                    this.animation.registerSkin(prefab.id, beforeSkinCount);
                }
            } else if (prefab.type === 'grid') {
                const model = this.createGrid({
                    size: prefab.size,
                    step: prefab.step,
                    lineWidth: prefab.lineWidth,
                });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cube') {
                const cube = prefab as unknown as CubePrefab;
                const model = this.createCube({ size: cube.size, textureId: (cube as any).texture, uv: cube.uv });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'plane') {
                const plane = prefab as PlanePrefab;
                const model = this.createPlane({
                    width: plane.width,
                    height: plane.height,
                    textureId: plane.texture,
                });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'sphere') {
                const sphere = prefab as unknown as SpherePrefab;
                const model = this.createSphere({ segments: sphere.segments, textureId: (sphere as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cylinder') {
                const cyl = prefab as unknown as CylinderPrefab;
                const model = this.createCylinder({ segments: cyl.segments, textureId: (cyl as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cone') {
                const cone = prefab as unknown as ConePrefab;
                const model = this.createCone({ segments: cone.segments, textureId: (cone as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'mesh') {
                const meshPrefab = prefab as unknown as MeshPrefab;
                const model = this.models.createMesh({
                    positions: meshPrefab.positions,
                    normals: meshPrefab.normals,
                    uvs: meshPrefab.uvs,
                    indices: meshPrefab.indices,
                    textureId: (meshPrefab as any).texture,
                });
                setPrefabHandle(prefab, model);
            }
        }
    }

    // textures upload/sampling lives in ./textures (TextureRegistry).

    private applyResize(w: number, h: number, cssW: number, cssH: number): void {
        this._width = w;
        this._height = h;

        if (this.options.autoResize) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.context.configure({
                device: this.device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'opaque',
            });
        }

        this.camera.setAspect(cssW, cssH);

        this.pipelines.resizeDepth(w, h);
        if (this.cameraEffects) {
            this.cameraEffects.setDepth(this.pipelines.depthTexture.createView(), this.pipelines.depthSampler, this.camera.near, this.camera.far);
        }
    }

    /**
     * Register a callback that fires when the canvas resizes.
     * Receives the new width and height in physical pixels.
     */
    onResize(callback: (width: number, height: number) => void): void {
        this.resize.onResize(callback);
    }

    createCompute(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.root);
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

    /**
     * Add a dynamic point or spot light. Returns a live handle whose position,
     * color, intensity, range, and enabled state can all be changed every frame.
     * Up to `MAX_LIGHTS` (64) lights may be live at once; throws past that.
     *
     * The global directional + ambient terms are separate — see
     * `setDirectionalLight` / `setAmbient`.
     */
    addLight(spec: LightSpec): LightHandle {
        return this.lights.add(spec);
    }

    /**
     * Set the global directional light (the "sun"). `direction` points from the
     * surface toward the light. Defaults to `(0.3, 0.8, 0.5)`, white, intensity 1
     * — the engine's classic fixed look.
     */
    setDirectionalLight(
        direction: readonly [number, number, number],
        color: readonly [number, number, number] = [1, 1, 1],
        intensity = 1,
    ): void {
        this.lights.setDirectional(direction, color, intensity);
    }

    /** Set the global ambient term. Defaults to `(0.3, 0.3, 0.3)`. */
    setAmbient(color: readonly [number, number, number]): void {
        this.lights.setAmbient(color);
    }

    /** Number of live dynamic lights. */
    get lightCount(): number {
        return this.lights.count;
    }

    /** Create a flat grid mesh on the XZ plane at Y=0. */
    createGrid(opts: { size?: number; step?: number; lineWidth?: number } = {}): ModelHandle {
        return this.models.createGrid(opts);
    }

    /** Create a cube mesh centered at the origin. */
    createCube(opts: { size?: number; textureId?: string; uv?: CubeUvMode } = {}): ModelHandle {
        return this.models.createCube(opts);
    }

    createSphere(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        return this.models.createSphere(opts);
    }

    createCylinder(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        return this.models.createCylinder(opts);
    }

    createCone(opts: { segments?: number; textureId?: string } = {}): ModelHandle {
        return this.models.createCone(opts);
    }

    /** Create a textured quad (plane) centered at the origin on the XY plane. */
    createPlane(opts: { width?: number; height?: number; textureId?: string } = {}): ModelHandle {
        return this.models.createPlane(opts);
    }

    /** Register a model from raw geometry data. Returns a handle for addInstance(). */
    loadModel(data: ModelData): ModelHandle {
        return this.models.loadModel(data);
    }

    /** Create a material (GPU resource) from a declarative spec. */
    createMaterial<U extends Record<string, AnyWgslData> = {}>(spec: MaterialSpec & { uniforms?: U }): MaterialHandle<U> {
        return this.materials.createMaterial<U>(spec as MaterialSpec);
    }

    /** Load a glTF/GLB model from a URL. */
    loadGltf(url: string, opts?: { animations?: string[] }): Promise<GltfModel> {
        return this.models.loadGltf(url, opts);
    }

    /** Upload a previously-parsed glTF to the GPU. */
    uploadParsedGltf(parsed: ParsedGltf): GltfModel {
        return this.models.uploadParsedGltf(parsed);
    }

    /**
     * Add an instance. For skinned models, pass `linkedTo` to share bone matrices
     * with another instance (e.g., when spawning all parts of a character).
     */
    addInstance(opts: MeshInstanceOptions<A>): InstanceHandle {
        // First-class the model to a simpler union type so narrowing works.
        const rawModel: ModelHandle | GltfModel | Prefab3D | string = opts.prefab as any;

        // Resolve string model ID to a Prefab3D via the asset bucket.
        let prefab: Prefab3D | undefined;
        if (typeof rawModel === 'string') {
            prefab = this._prefabs?.get(rawModel) as unknown as Prefab3D | undefined;
            if (!prefab) throw new Error(`addInstance: prefab '${rawModel}' not found`);
            opts = { ...opts, prefab: prefab };
        } else if (isPrefab3D(rawModel)) {
            prefab = rawModel;
        }

        const userPrefabId = prefab ? prefab.id : null;

        // Composite prefab: spawn each part with its baked offset composed
        // onto the instance transform.
        if (prefab?.type === 'composite') {
            return this.addCompositeInstance(opts, prefab);
        }

        // Resolve prefab -> renderer handle if needed.
        const resolved = prefab ? resolvePrefabHandle(prefab) : opts.prefab;

        // GltfModel: spawn all parts as a linked group
        if ('parts' in (resolved as ModelHandle | GltfModel)) {
            return this.addGltfInstance(opts, resolved as GltfModel, userPrefabId);
        }

        const modelHandle = resolved as ModelHandle;
        const model = this.models.get(modelHandle.id);

        // Route skinned models to the skinned instance path
        if (model?.skinned) {
            return this.addSkinnedInstance(opts, modelHandle, model.skinIndex, undefined, userPrefabId);
        }

        const materialId = opts.material ? opts.material.slot + 1 : 0;
        return this.instances.spawn(opts, modelHandle, userPrefabId, ++this.nextInstanceId, materialId);
    }

    private addGltfInstance(opts: MeshInstanceOptions<A>, gltf: GltfModel, prefabId: string | null): InstanceHandle {
        const childHandles: MeshInstanceHandle[] = [];
        let firstSkinnedSlot: number | undefined;

        for (const part of gltf.parts) {
            const partOpts = { ...opts, model: part };
            const model = this.models.get(part.id);

            let handle: MeshInstanceHandle;
            if (model?.skinned) {
                handle = this.addSkinnedInstance(partOpts, part, model.skinIndex, firstSkinnedSlot, prefabId);
                if (firstSkinnedSlot === undefined) firstSkinnedSlot = handle.slot;
            } else {
                // Re-use the single-part non-skinned path directly
                handle = this.addInstance(partOpts) as MeshInstanceHandle;
            }
            childHandles.push(handle);
        }

        // Find the first skinned handle for animation control
        const skinnedHandle = childHandles.find(h => h.skinned);

        // The user-facing handle reads transforms from the first child (all children share the same logical pose).
        const lead = childHandles[0];

        return {
            id: lead.id,
            skinned: gltf.skinned,
            prefabId,
            get textureId() { return lead.textureId; },
            setPosition(x: number, y: number, z: number) {
                for (const h of childHandles) h.setPosition(x, y, z);
            },
            setRotation(x: number, y: number, z: number) {
                for (const h of childHandles) h.setRotation(x, y, z);
            },
            setScale(x: number, y: number, z: number) {
                for (const h of childHandles) h.setScale(x, y, z);
            },
            teleport(x: number, y: number, z: number) {
                for (const h of childHandles) h.teleport(x, y, z);
            },
            get position() { return lead.position; },
            get rotation() { return lead.rotation; },
            get scale() { return lead.scale; },
            play: skinnedHandle?.play ? (name: string, opts?: PlayOptions) => {
                skinnedHandle.play!(name, opts);
            } : undefined,
            stop: skinnedHandle?.stop ? () => {
                skinnedHandle.stop!();
            } : undefined,
            setTexture(tex: string | TexturePrefab | null) {
                for (const h of childHandles) h.setTexture?.(tex);
            },
            destroy() {
                for (const h of childHandles) h.destroy();
            },
        };
    }

    /**
     * Spawn a composite prefab by spawning each of its parts at the composed
     * (instance + offset) transform. The returned handle broadcasts subsequent
     * `setPosition` / `setRotation` to every child, keeping each child's
     * baked offset applied on top of the new value.
     */
    private addCompositeInstance(opts: MeshInstanceOptions<A>, composite: CompositePrefab): InstanceHandle {
        const bucket = this._prefabs;
        if (!bucket) {
            throw new Error(
                `addInstance: composite '${composite.id}' requires the renderer to be constructed with the bucket (\`prefabs\`).`,
            );
        }

        const basePos = opts.position ?? [0, 0, 0];
        const baseRot = opts.rotation ?? [0, 0, 0];

        // Snapshot offsets so setPosition/setRotation broadcasts can re-apply them.
        const offsets = composite.parts.map((p) => ({
            px: p.offset?.position?.[0] ?? 0,
            py: p.offset?.position?.[1] ?? 0,
            pz: p.offset?.position?.[2] ?? 0,
            rx: p.offset?.rotation?.[0] ?? 0,
            ry: p.offset?.rotation?.[1] ?? 0,
            rz: p.offset?.rotation?.[2] ?? 0,
        }));

        const childHandles: InstanceHandle[] = [];
        // Track the logical (un-offset) pose set by the user. Children carry their
        // offsets, so reading position back from any child would include the offset.
        // Reusable tuples for getters; mutated on each read.
        const posOut: [number, number, number] = [basePos[0], basePos[1], basePos[2]];
        const rotOut: [number, number, number] = [baseRot[0], baseRot[1], baseRot[2]];
        const sclOut: [number, number, number] = [1, 1, 1];
        const initialScale = opts.scale;
        if (typeof initialScale === 'number') { sclOut[0] = sclOut[1] = sclOut[2] = initialScale; }
        else if (initialScale) { sclOut[0] = initialScale[0]; sclOut[1] = initialScale[1]; sclOut[2] = initialScale[2]; }

        for (let i = 0; i < composite.parts.length; i++) {
            const part = composite.parts[i];
            const off = offsets[i];
            const partPrefab = bucket.get(part.partId) as unknown as Prefab3D;
            const partOpts: MeshInstanceOptions<A> = {
                ...opts,
                prefab: partPrefab,
                position: [basePos[0] + off.px, basePos[1] + off.py, basePos[2] + off.pz],
                rotation: [baseRot[0] + off.rx, baseRot[1] + off.ry, baseRot[2] + off.rz],
            };
            childHandles.push(this.addInstance(partOpts));
        }

        return {
            id: childHandles[0].id,
            skinned: childHandles.some((h) => h.skinned),
            prefabId: composite.id,
            get textureId() { return childHandles[0].textureId; },
            setPosition(x: number, y: number, z: number) {
                posOut[0] = x; posOut[1] = y; posOut[2] = z;
                for (let i = 0; i < childHandles.length; i++) {
                    const o = offsets[i];
                    childHandles[i].setPosition(x + o.px, y + o.py, z + o.pz);
                }
            },
            setRotation(x: number, y: number, z: number) {
                rotOut[0] = x; rotOut[1] = y; rotOut[2] = z;
                for (let i = 0; i < childHandles.length; i++) {
                    const o = offsets[i];
                    childHandles[i].setRotation(x + o.rx, y + o.ry, z + o.rz);
                }
            },
            setScale(x: number, y: number, z: number) {
                sclOut[0] = x; sclOut[1] = y; sclOut[2] = z;
                for (const h of childHandles) h.setScale(x, y, z);
            },
            teleport(x: number, y: number, z: number) {
                posOut[0] = x; posOut[1] = y; posOut[2] = z;
                for (let i = 0; i < childHandles.length; i++) {
                    const o = offsets[i];
                    childHandles[i].teleport(x + o.px, y + o.py, z + o.pz);
                }
            },
            get position() { return posOut as readonly [number, number, number]; },
            get rotation() { return rotOut as readonly [number, number, number]; },
            get scale() { return sclOut as readonly [number, number, number]; },
            setTexture(tex: string | TexturePrefab | null) {
                for (const h of childHandles) h.setTexture?.(tex);
            },
            destroy() {
                for (const h of childHandles) h.destroy();
            },
        };
    }

    private addSkinnedInstance(
        opts: MeshInstanceOptions<A>,
        modelHandle: ModelHandle,
        skinIndex: number,
        linkedSlot?: number,
        prefabId: string | null = null,
    ): MeshInstanceHandle {
        const skinModel = this.models.skinnedModel(skinIndex);
        return this.skinned.spawn(
            opts, modelHandle, skinIndex,
            skinModel as unknown as SkinModelLike,
            linkedSlot, prefabId, ++this.nextInstanceId,
        );
    }

    /**
     * Free an instance's renderer slot. Equivalent to `handle.destroy()` -
     * kept as a convenience for direct lookup. Safe to call multiple times.
     */
    removeInstance(handle: InstanceHandle): void {
        handle.destroy();
    }

    storePreviousState(): void {
        this.camera.storePrevious();

        this.instances.storePrevious();

        this.skinned.storePrevious();

        // Dynamic lights — snapshot curr -> prev so moving lights interpolate.
        this.lights.storePrevious();
    }

    /** Resolve an instance's declared hitbox name to its Hitbox via the bucket's library. */
    private resolveHitbox(handle: MeshInstanceHandle): Hitbox<'3d'> | null {
        if (!this._prefabs || !handle.prefabId) return null;
        const lib = this._prefabs.hitboxLibrary;
        if (!lib) return null;
        const prefab = this._prefabs.get(handle.prefabId) as unknown as Prefab3D | undefined;
        const name = prefab?.hitbox;
        return name ? (lib.get(name as never) as Hitbox<'3d'>) : null;
    }

    /**
     * Pick test for a single instance. Returns the ray-`t` and the struck
     * part name, or `null`. Uses the prefab's declared hitbox when
     * available; falls back to the model's axis-aligned bounding box.
     */
    _collectRaycastHitsInto(screenX: number, screenY: number, rc: RaycastState): void {
        this.raycastController.collect(screenX, screenY, rc);
    }

    /** Visit every live instance with world position, scale and half-extents. */
    private eachInstance(
        visit: (
            handle: MeshInstanceHandle,
            cx: number, cy: number, cz: number,
            sx: number, sy: number, sz: number,
            halfX: number, halfY: number, halfZ: number,
        ) => void,
    ): void {
        const dyn = this.instances.dynamicData;
        const stat = this.instances.staticData;
        const models = this.models;
        this.instances.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.instances.instanceHandles[slot];
                if (handle === null) continue;
                const model = models.get(handle.modelId);
                if (!model) continue;
                const dynBase = slot * DYNAMIC_MESH_FLOATS;
                const statBase = slot * STATIC_MESH_FLOATS;
                visit(handle,
                    dyn[dynBase + DYN_CURR_PX], dyn[dynBase + DYN_CURR_PY], dyn[dynBase + DYN_CURR_PZ],
                    stat[statBase + STAT_SX], stat[statBase + STAT_SY], stat[statBase + STAT_SZ],
                    model.halfX, model.halfY, model.halfZ);
            }
        });

        const sDyn = this.skinned.dynamicData;
        const sStat = this.skinned.staticData;
        this.skinned.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.skinned.instanceHandles[slot];
                if (handle === null) continue;
                const model = models.get(handle.modelId);
                if (!model) continue;
                const skin = this.models.skinnedModel(model.skinIndex);
                if (!skin) continue;
                const dynBase = slot * DYNAMIC_MESH_FLOATS;
                const statBase = slot * SKINNED_STATIC_MESH_FLOATS;
                visit(handle,
                    sDyn[dynBase + DYN_CURR_PX], sDyn[dynBase + DYN_CURR_PY], sDyn[dynBase + DYN_CURR_PZ],
                    sStat[statBase + SSTAT_SX], sStat[statBase + SSTAT_SY], sStat[statBase + SSTAT_SZ],
                    model.halfX, model.halfY, model.halfZ);
            }
        });
    }

    render(alpha: number): void {
        if (!this._initialized) return;

        // Advance skeletal animations at render framerate
        const now = performance.now();
        let frameDelta = 0;
        if (this.lastRenderTime > 0) {
            frameDelta = (now - this.lastRenderTime) / 1000;
            this.elapsed += frameDelta;
            this.animation.update(frameDelta);
        }
        this.lastRenderTime = now;

        this.camera.interpolate(alpha);

        // Upload dynamic data
        this.device.queue.writeBuffer(
            this.pipelines.rawDynamicBuffer, 0,
            this.instances.dynamicData.buffer, this.instances.dynamicData.byteOffset, this.instances.dynamicData.byteLength,
        );

        // Upload static data
        if (this.instances.staticDirty) {
            this.device.queue.writeBuffer(
                this.pipelines.rawStaticBuffer, 0,
                this.instances.staticData.buffer, this.instances.staticData.byteOffset, this.instances.staticData.byteLength,
            );
            this.instances.staticDirty = false;
        }

        // Pack enabled lights densely and upload them.
        const packed = this.lights.pack();
        if (packed.count > 0) {
            this.device.queue.writeBuffer(
                this.pipelines.rawLightBuffer, 0,
                packed.data.buffer, packed.data.byteOffset, packed.byteLength,
            );
        }

        // Upload uniforms: VP matrix + alpha, then the directional/ambient/count block.
        const vpMatrix = this.camera.getViewProjectionMatrix();
        this.uniformData.set(vpMatrix, 0);
        this.uniformData[MESH_UNIFORM_ALPHA_OFFSET] = alpha;
        this.lights.writeUniforms(this.uniformData, MESH_UNIFORM_LIGHT_OFFSET, packed.count);
        const camPos = this.camera.position;
        this.uniformData[MESH_UNIFORM_CAMERA_OFFSET] = camPos[0];
        this.uniformData[MESH_UNIFORM_CAMERA_OFFSET + 1] = camPos[1];
        this.uniformData[MESH_UNIFORM_CAMERA_OFFSET + 2] = camPos[2];
        this.uniformData[MESH_UNIFORM_TIME_OFFSET] = this.elapsed;
        this.uniformData[MESH_UNIFORM_RESOLUTION_OFFSET] = this._width;
        this.uniformData[MESH_UNIFORM_RESOLUTION_OFFSET + 1] = this._height;
        this.device.queue.writeBuffer(
            this.pipelines.rawUniformBuffer, 0,
            this.uniformData.buffer, this.uniformData.byteOffset,
            this.uniformData.byteLength,
        );

        // Extract frustum planes from VP matrix for culling
        this.frustum.setFromViewProjection(vpMatrix);

        // Pack slot indices per model, with frustum culling
        let indexOffset = 0;
        const batchOffsets: { modelId: number; materialId: number; offset: number; count: number }[] = [];
        const dyn = this.instances.dynamicData;
        const stat = this.instances.staticData;

        this.instances.batcher.each((modelId, instances, count, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            const model = this.models.get(modelId);
            if (!model) return;
            const baseRadius = model.boundingRadius;
            const batchStart = indexOffset;

            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * STATIC_MESH_FLOATS;

                // Use current position for culling
                const cx = dyn[base + DYN_CURR_PX];
                const cy = dyn[base + DYN_CURR_PY];
                const cz = dyn[base + DYN_CURR_PZ];

                // Scale the bounding radius by max scale axis
                const sx = stat[sBase + STAT_SX];
                const sy = stat[sBase + STAT_SY];
                const sz = stat[sBase + STAT_SZ];
                const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                const radius = baseRadius * maxScale;

                // Frustum sphere test
                if (this.frustum.intersectsSphere(cx, cy, cz, radius)) {
                    this.instances.slotIndexData[indexOffset++] = slot;
                }
            }

            const visibleCount = indexOffset - batchStart;
            if (visibleCount > 0) {
                batchOffsets.push({ modelId, materialId, offset: batchStart, count: visibleCount });
            }
        });

        if (indexOffset > 0) {
            this.device.queue.writeBuffer(
                this.pipelines.rawSlotIndexBuffer, 0,
                this.instances.slotIndexData.buffer, this.instances.slotIndexData.byteOffset,
                indexOffset * 4,
            );
        }

        // --- Upload skinned buffers ---
        this.device.queue.writeBuffer(
            this.pipelines.rawSkinnedDynamicBuffer, 0,
            this.skinned.dynamicData.buffer, this.skinned.dynamicData.byteOffset, this.skinned.dynamicData.byteLength,
        );

        if (this.skinned.staticDirty) {
            this.device.queue.writeBuffer(
                this.pipelines.rawSkinnedStaticBuffer, 0,
                this.skinned.staticData.buffer, this.skinned.staticData.byteOffset, this.skinned.staticData.byteLength,
            );
            this.skinned.staticDirty = false;
        }

        // Upload bone matrices from CPU only if GPU compute is not active
        this.animation.flushBoneMatrices();

        // Pack skinned slot indices
        let skinnedIndexOffset = 0;
        const skinnedBatchOffsets: { modelId: number; offset: number; count: number }[] = [];
        const sDyn = this.skinned.dynamicData;
        const sStat = this.skinned.staticData;

        this.skinned.batcher.each((modelId, instances, count) => {
            const model = this.models.get(modelId);
            if (!model) return;
            const batchStart = skinnedIndexOffset;

            // Frustum cull skinned instances using per-skin bounding radius
            const skinModel = model.skinIndex >= 0 ? this.models.skinnedModel(model.skinIndex) : null;
            const baseRadius = skinModel?.boundingRadius ?? 10;

            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * SKINNED_STATIC_MESH_FLOATS;

                const cx = sDyn[base + DYN_CURR_PX];
                const cy = sDyn[base + DYN_CURR_PY];
                const cz = sDyn[base + DYN_CURR_PZ];

                // Scale the bounding radius by instance scale
                const sx = sStat[sBase + SSTAT_SX];
                const sy = sStat[sBase + SSTAT_SY];
                const sz = sStat[sBase + SSTAT_SZ];
                const maxScale = Math.abs(sx) > Math.abs(sy) ? (Math.abs(sx) > Math.abs(sz) ? Math.abs(sx) : Math.abs(sz)) : (Math.abs(sy) > Math.abs(sz) ? Math.abs(sy) : Math.abs(sz));
                const radius = baseRadius * maxScale;

                if (this.frustum.intersectsSphere(cx, cy, cz, radius)) {
                    this.skinned.slotIndexData[skinnedIndexOffset++] = slot;
                }
            }

            const visibleCount = skinnedIndexOffset - batchStart;
            if (visibleCount > 0) {
                skinnedBatchOffsets.push({ modelId, offset: batchStart, count: visibleCount });
            }
        });

        if (skinnedIndexOffset > 0) {
            this.device.queue.writeBuffer(
                this.pipelines.rawSkinnedSlotIndexBuffer, 0,
                this.skinned.slotIndexData.buffer, this.skinned.slotIndexData.byteOffset,
                skinnedIndexOffset * 4,
            );
        }

        // Compute + render in same command encoder (single submission)
        const swapchainView = this.context.getCurrentTexture().createView();
        const effectList = this.camera.effects;
        const enabledEffects = effectList.enableCount();
        const targetView = enabledEffects > 0 ? this.cameraEffects.sceneTarget(this._width, this._height) : swapchainView;
        // Flush queued particle spawns and advance the pool once per frame.
        this.particles.simulate(frameDelta);
        const encoder = this.device.createCommandEncoder();

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
                view: this.pipelines.depthTexture.createView(),
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 1.0,
            },
        });

        // --- Draw non-skinned models (pass 0: opaque, pass 1: transparent) ---
        let currentPipeline: GPURenderPipeline | null = null;

        for (let passIndex = 0; passIndex < 2; passIndex++) {
            currentPipeline = null;

            for (const batch of batchOffsets) {
                const model = this.models.get(batch.modelId);
                if (!model) continue;

                const material = batch.materialId > 0 ? this.materials.get(batch.materialId) : null;
                const transparent = material ? material.transparent : false;
                if ((passIndex === 1) !== transparent) continue;

                if (material) {
                    if (material.pipeline !== currentPipeline) {
                        pass.setPipeline(material.pipeline);
                        pass.setBindGroup(0, this.pipelines.rawBindGroup);
                        currentPipeline = material.pipeline;
                    }
                    pass.setBindGroup(1, material.bindGroup);
                    pass.setVertexBuffer(0, model.rawVertexBuffer);
                    if (model.rawIndexBuffer) {
                        pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                        pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                    } else {
                        pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                    }
                    continue;
                }

                // Check if any instance in this batch has a per-instance texture override
                let hasCustomTex = false;
                for (let i = 0; i < batch.count; i++) {
                    const slot = this.instances.slotIndexData[batch.offset + i];
                    if (this.instances.textureBindGroup(slot) !== undefined) {
                        hasCustomTex = true;
                        break;
                    }
                }

                const needsTextured = model.hasTexture || hasCustomTex;
                const pipeline = needsTextured ? this.pipelines.rawTexturedPipeline : this.pipelines.rawPipeline;
                if (pipeline !== currentPipeline) {
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.pipelines.rawBindGroup);
                    currentPipeline = pipeline;
                }

                if (!needsTextured) {
                    // Untextured — draw entire batch at once
                    pass.setVertexBuffer(0, model.rawVertexBuffer);
                    if (model.rawIndexBuffer) {
                        pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                        pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                    } else {
                        pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                    }
                    continue;
                }

                // Textured — per-instance bind group (custom override, model default, or white fallback)
                pass.setVertexBuffer(0, model.rawVertexBuffer);
                if (model.rawIndexBuffer) pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                const whiteBG = this.textures.white;
                for (let i = 0; i < batch.count; i++) {
                    const slot = this.instances.slotIndexData[batch.offset + i];
                    const customBG = this.instances.textureBindGroup(slot);
                    pass.setBindGroup(1, customBG ?? model.textureBindGroup ?? whiteBG);
                    if (model.rawIndexBuffer) {
                        pass.drawIndexed(model.indexCount, 1, 0, 0, batch.offset + i);
                    } else {
                        pass.draw(model.vertexCount, 1, 0, batch.offset + i);
                    }
                }
            }
        }

        // --- Draw skinned models ---
        currentPipeline = null;

        for (const batch of skinnedBatchOffsets) {
            const model = this.models.get(batch.modelId);
            if (!model) continue;

            // Check for per-instance texture overrides in this batch
            let hasCustomTex = false;
            for (let i = 0; i < batch.count; i++) {
                const slot = this.skinned.slotIndexData[batch.offset + i];
                if (this.skinned.textureBindGroup(slot) !== undefined) {
                    hasCustomTex = true;
                    break;
                }
            }

            const needsTextured = model.hasTexture || hasCustomTex;
            const pipeline = needsTextured ? this.pipelines.rawSkinnedTexturedPipeline : this.pipelines.rawSkinnedPipeline;
            if (pipeline !== currentPipeline) {
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.pipelines.rawSkinnedBindGroup);
                currentPipeline = pipeline;
            }

            if (!needsTextured) {
                pass.setVertexBuffer(0, model.rawVertexBuffer);
                if (model.rawIndexBuffer) {
                    pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                    pass.drawIndexed(model.indexCount, batch.count, 0, 0, batch.offset);
                } else {
                    pass.draw(model.vertexCount, batch.count, 0, batch.offset);
                }
                continue;
            }

            pass.setVertexBuffer(0, model.rawVertexBuffer);
            if (model.rawIndexBuffer) pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
            const whiteBG = this.textures.white;
            for (let i = 0; i < batch.count; i++) {
                const slot = this.skinned.slotIndexData[batch.offset + i];
                const customBG = this.skinned.textureBindGroup(slot);
                pass.setBindGroup(1, customBG ?? model.textureBindGroup ?? whiteBG);
                if (model.rawIndexBuffer) {
                    pass.drawIndexed(model.indexCount, 1, 0, 0, batch.offset + i);
                } else {
                    pass.draw(model.vertexCount, 1, 0, batch.offset + i);
                }
            }
        }

        if (this.debug.hitboxes) {
            this.drawDebugHitboxes(pass, vpMatrix);
        }

        cameraBasis(this.camera.position, this.camera.target, this.camera.up, this._camRight, this._camUp);
        this.particles.draw(pass, vpMatrix, this._camRight, this._camUp);

        pass.end();

        if (enabledEffects > 0) {
            this.cameraEffects.apply(encoder, swapchainView, effectList, this.elapsed, this._width, this._height);
        }

        this.device.queue.submit([encoder.finish()]);
    }

    private drawDebugHitboxes(pass: GPURenderPassEncoder, vp: Float32Array): void {
        if (!this._prefabs) return;
        const debug = this.hitboxDebug;
        const state = this.raycast.state;
        debug.begin(vp);

        const dyn = this.instances.dynamicData;
        const stat = this.instances.staticData;
        this.instances.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.instances.instanceHandles[slot];
                if (handle === null) continue;
                const hb = this.resolveHitbox(handle);
                if (!hb) continue;
                const dynBase = slot * DYNAMIC_MESH_FLOATS;
                const statBase = slot * STATIC_MESH_FLOATS;
                const hovered = state.containsId(handle.id);
                for (const part of hb.parts) {
                    debug.emit(
                        part, hovered,
                        dyn[dynBase + DYN_CURR_PX], dyn[dynBase + DYN_CURR_PY], dyn[dynBase + DYN_CURR_PZ],
                        stat[statBase + STAT_SX], stat[statBase + STAT_SY], stat[statBase + STAT_SZ],
                    );
                }
            }
        });

        const sDyn = this.skinned.dynamicData;
        const sStat = this.skinned.staticData;
        this.skinned.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.skinned.instanceHandles[slot];
                if (handle === null) continue;
                const hb = this.resolveHitbox(handle);
                if (!hb) continue;
                const dynBase = slot * DYNAMIC_MESH_FLOATS;
                const statBase = slot * SKINNED_STATIC_MESH_FLOATS;
                const hovered = state.containsId(handle.id);
                for (const part of hb.parts) {
                    debug.emit(
                        part, hovered,
                        sDyn[dynBase + DYN_CURR_PX], sDyn[dynBase + DYN_CURR_PY], sDyn[dynBase + DYN_CURR_PZ],
                        sStat[statBase + SSTAT_SX], sStat[statBase + SSTAT_SY], sStat[statBase + SSTAT_SZ],
                    );
                }
            }
        });

        debug.flush(pass);
    }

    // Visibility + skinning culling lives in ./cull (Frustum, SkinCull).

    destroy(): void {
        this.resize?.disconnect();
        // Detach from the bucket so it doesn't retain this dead renderer via the coordinator's closure.
        this.animation?.dispose();
        this.cameraEffects?.destroy();
        this.particles?.destroy();
        this.pipelines?.destroy();
        this.models?.destroy();
        this.root?.destroy();
    }
}

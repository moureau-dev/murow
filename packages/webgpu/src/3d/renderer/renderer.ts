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
import { LightSystem } from './managers/lights';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import { MaterialLibrary } from './managers/materials';
import { ShadowSystem } from './managers/shadows';
import { SpotShadowSystem } from './managers/shadows/spot-shadow-system';
import { PointShadowSystem } from './managers/shadows/point-shadow-system';
import type { MaterialSpec } from './managers/materials/specs';
import { CameraEffectStack } from './managers/camera/camera-effects';
import { Logger } from 'murow/core';
import { ParticleSystem3D } from './managers/particles/particle-system-3d';
import { ModelsManager } from './managers/models';
import { TextureRegistry } from './internals/texture-registry';
import { ResizeController } from './internals/resize-controller';
import { RaycastController } from './internals/raycast';
import { InstanceStore, SkinnedInstanceStore } from './managers/instances';
import { MeshPipelines } from './internals/mesh-pipelines';
import { SkeletalRuntime } from './internals/skeletal-runtime';
import { ModelLibrary } from './internals/model-library';
import {
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    STAT_SX, STAT_SY, STAT_SZ,
    SSTAT_SX, SSTAT_SY, SSTAT_SZ, SSTAT_MATERIAL_ID,
} from './managers/instances/offsets';
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
import { WebGPURaycast3D, type RaycastState } from './internals/raycast';
import { HitboxDebugRenderer } from '../hitbox';
import { SkinCull } from './internals/skin-cull';
import { RendererCore } from './core/renderer-core';
import { InstanceManager, setPrefabHandle } from './managers/instances';
import { MaterialManager } from './managers/materials';
import { LightManager } from './managers/lights';
import { ShadowManager } from './managers/shadows';
import { DecalManager } from './managers/decals';
import { ParticleManager } from './managers/particles';
import { CameraManager } from './managers/camera';
import type { Interpolator } from './types';
import { DEFAULT_CAPACITIES } from './defaults';
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
    private raycastController!: RaycastController;

    private readonly maxTotalBones: number;

    // Skeletal animation runtime (clip packing, compute kernel, bone buffer).
    private animation!: SkeletalRuntime;

    private readonly maxSkinnedInstances: number;
    private readonly maxBonesPerSkin: number;

    private readonly skinCull: SkinCull;

    /** Per-model visible batch offsets for the main non-skinned pass. Reused each frame. */
    private readonly batchOffsets: { modelId: number; materialId: number; offset: number; count: number }[] = [];
    /** Per-model visible batch offsets for the main skinned pass. Reused each frame. */
    private readonly skinnedBatchOffsets: { modelId: number; offset: number; count: number }[] = [];

    readonly camera: CameraManager;
    readonly raycast: WebGPURaycast3D;
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
        this.raycastController = new RaycastController({
            camera: this.camera,
            eachInstance: (visit) => this.eachInstance(visit),
            resolveHitbox: (handle) => this.resolveHitbox(handle),
        });
        this.raycast = new WebGPURaycast3D(this);

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
        this.core.root = tgpu.initFromDevice({ device });
        this.core.device = this.core.root.device;

        this.core.context = this.canvas.getContext('webgpu')!;
        this.core.format = navigator.gpu.getPreferredCanvasFormat();
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

        this.cameraEffects = new CameraEffectStack({ root: this.core.root, format: this.core.format, maxEffects: this.maxCameraEffects });
        this.cameraEffects.setDepth(this.core.pipelines.depthTexture.createView(), this.core.pipelines.depthSampler, this.camera.near, this.camera.far);

        const shadowSystem = new ShadowSystem({
            root: this.core.root,
            dynamicBuffer: this.core.pipelines.rawDynamicBuffer,
            staticBuffer: this.core.pipelines.rawStaticBuffer,
            maxInstances: this.maxInstances,
            skinned: {
                dynamicBuffer: this.core.pipelines.rawSkinnedDynamicBuffer,
                staticBuffer: this.core.pipelines.rawSkinnedStaticBuffer,
                boneBuffer: this.core.pipelines.rawBoneMatrixBuffer,
                maxInstances: this.maxSkinnedInstances,
                maxBones: this.maxTotalBones,
                vertexBufferLayout: this.core.pipelines.skinnedVertexBufferLayout,
            },
        }, { resolution: (this.options as WebGPU3DRendererOptions).shadowResolution ?? 2048 });

        const spotShadowSystem = new SpotShadowSystem({
            root: this.core.root,
            dynamicBuffer: this.core.pipelines.rawDynamicBuffer,
            staticBuffer: this.core.pipelines.rawStaticBuffer,
            maxInstances: this.maxInstances,
            skinned: {
                dynamicBuffer: this.core.pipelines.rawSkinnedDynamicBuffer,
                staticBuffer: this.core.pipelines.rawSkinnedStaticBuffer,
                boneBuffer: this.core.pipelines.rawBoneMatrixBuffer,
                maxInstances: this.maxSkinnedInstances,
                maxBones: this.maxTotalBones,
                vertexBufferLayout: this.core.pipelines.skinnedVertexBufferLayout,
            },
        }, { maxShadows: (this.options as WebGPU3DRendererOptions).maxSpotShadows });

        const pointShadowSystem = new PointShadowSystem({
            root: this.core.root,
            dynamicBuffer: this.core.pipelines.rawDynamicBuffer,
            staticBuffer: this.core.pipelines.rawStaticBuffer,
            maxInstances: this.maxInstances,
            skinned: {
                dynamicBuffer: this.core.pipelines.rawSkinnedDynamicBuffer,
                staticBuffer: this.core.pipelines.rawSkinnedStaticBuffer,
                boneBuffer: this.core.pipelines.rawBoneMatrixBuffer,
                maxInstances: this.maxSkinnedInstances,
                maxBones: this.maxTotalBones,
                vertexBufferLayout: this.core.pipelines.skinnedVertexBufferLayout,
            },
        }, {
            maxShadows: (this.options as WebGPU3DRendererOptions).maxPointShadows,
            resolution: (this.options as WebGPU3DRendererOptions).pointShadowResolution,
        });

        this.core.textures = new TextureRegistry(this.core.device, this.core.pipelines.rawTexturedPipeline.getBindGroupLayout(1));
        this.core.textures.initWhiteFallback();
        if (this._assets) {
            // The bucket accessor proxy binds methods per access; capture it once.
            const findTexture = this._assets.textures.find;
            this.core.textures.setResolver((id) => findTexture(id));
        }

        const maxParticleEmitters = rendererOptions.maxParticleEmitters ?? 64;
        const maxParticles = rendererOptions.maxParticles ?? 4096;
        const lightSystem = new LightSystem(maxLights);
        const particleSystem = new ParticleSystem3D({
            root: this.core.root,
            format: this.core.format,
            maxParticles,
            maxMaterials: rendererOptions.maxParticleMaterials ?? 16,
            maxEmitters: maxParticleEmitters,
            resolveTexture: (id) => this.core.textures.get(id),
            logger: this.logger,
        });

        const maxMaterials = rendererOptions.maxMaterials ?? DEFAULT_CAPACITIES.materials;
        const materialLibrary = new MaterialLibrary({
            root: this.core.root,
            device: this.core.device,
            pipelines: this.core.pipelines,
            textures: this.core.textures,
            meshLayout: this.core.pipelines.meshLayout,
            skinnedLayout: this.core.pipelines.skinnedMeshLayout,
            shadow: shadowSystem,
            spotShadow: spotShadowSystem,
            pointShadow: pointShadowSystem,
            maxMaterials,
        });
        // Changing `renderer.shadows.resolution` rebinds every material.
        shadowSystem.setResolutionHook(() => materialLibrary.rebuildBindGroups());
        this.core.materialLibrary = materialLibrary;

        // Instance stores are created here so their material refcounting can
        // reach the library; the animation runtime reads the skinned store.
        const retainMaterial = (materialId: number) => materialLibrary.retain(materialId);
        const releaseMaterial = (materialId: number) => materialLibrary.release(materialId);
        const instanceStore = new InstanceStore({
            maxInstances: this.maxInstances,
            getTextureBindGroup: (id) => this.core.textures.get(id)?.bindGroup,
            retainMaterial,
            releaseMaterial,
        });
        const skinnedStore = new SkinnedInstanceStore({
            maxSkinnedInstances: this.maxSkinnedInstances,
            maxTotalBones: this.maxTotalBones,
            maxSkins: this._prefabs ? this._prefabs.size : 64,
            uploadRestPose: (skinModel, boneOffset, jointCount) => this.animation.writeRestPose(skinModel, boneOffset, jointCount),
            getTextureBindGroup: (id) => this.core.textures.get(id)?.bindGroup,
            retainMaterial,
            releaseMaterial,
        });

        this.materials = new MaterialManager({
            capacity: maxMaterials,
            logger: this.logger,
            library: materialLibrary,
            reassignUsers: (materialId) => this.instances?.reassignMaterial(materialId),
        });
        this.lights = new LightManager({ capacity: maxLights, logger: this.logger, system: lightSystem });
        this.particles = new ParticleManager({
            capacity: { maxEmitters: maxParticleEmitters, maxParticles },
            logger: this.logger,
            system: particleSystem,
        });

        this.animation = new SkeletalRuntime({
            root: this.core.root,
            device: this.core.device,
            pipelines: this.core.pipelines,
            skinned: skinnedStore,
            camera: this.camera,
            skinCull: this.skinCull,
            maxSkinnedInstances: this.maxSkinnedInstances,
            maxTotalBones: this.maxTotalBones,
            maxSkins: this._prefabs ? this._prefabs.size : 64,
            getModel: (id) => this.core.models.get(id),
            getSkinModel: (i) => this.core.models.skinnedModel(i),
            skinnedModelCount: () => this.core.models.skinnedModelCount(),
        });

        this.core.models = new ModelLibrary({
            device: this.core.device,
            pipelines: this.core.pipelines,
            textures: this.core.textures,
            onSkinLoaded: (skinData, animClips) => this.animation.addSkin(skinData, animClips),
        });
        this.models = new ModelsManager(this.core.models);

        if (this._prefabs) {
            await this.uploadPrefabBucket(this._assets!);
        }

        this.instances = new InstanceManager({
            capacity: this.maxInstances,
            poolSize: this.maxInstances + this.maxSkinnedInstances,
            logger: this.logger,
            store: instanceStore,
            skinned: skinnedStore,
            models: this.core.models,
            prefabs: this._prefabs,
            getSkinModel: (index) => this.core.models.skinnedModel(index),
        });
        this.shadows = new ShadowManager({
            directional: shadowSystem,
            spot: spotShadowSystem,
            point: pointShadowSystem,
            instances: this.instances,
            materials: this.materials,
            lights: this.lights,
            camera: this.camera,
            core: this.core,
            motionVersion: () => this.instances.store.dynamicVersion + this.instances.skinnedStore.dynamicVersion + this.animation.version,
        });
        this.decals = new DecalManager({
            capacity: rendererOptions.maxDecals ?? 16,
            logger: this.logger,
            createMaterial: (spec) => this.materials.create(spec) as never,
            addDecalInstance: (prefab, material) => this.instances!.add({
                prefab,
                position: [0, -10000, 0],
                scale: 0.001,
                material,
            }) as never,
            elapsedSeconds: () => this.elapsed,
        });

        // Snapshot order is irrelevant; the three snapshots are independent.
        this.interpolators = [this.camera, this.instances, this.lights];

        this.hitboxDebug.init(this.core.device, this.core.format);
        this.resize = new ResizeController(
            this.canvas,
            (w, h, cssW, cssH) => this.applyResize(w, h, cssW, cssH),
            undefined,
            (this.options as WebGPU3DRendererOptions).maxPixelRatio ?? Infinity,
        );
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
                texturePromises.push(this.core.textures.upload(prefab as TexturePrefab));
            }
        }
        await Promise.all(texturePromises);

        for (const prefab of bucket.entries()) {
            if (prefab.type === 'gltf') {
                const beforeSkinCount = this.core.models.skinnedModelCount();
                const model = this.models.uploadParsedGltf(prefab.parsed);
                setPrefabHandle(prefab, model);
                if (this.core.models.skinnedModelCount() > beforeSkinCount) {
                    this.animation.registerSkin(prefab.id, beforeSkinCount);
                }
            } else if (prefab.type === 'grid') {
                const model = this.models.createGrid({
                    size: prefab.size,
                    step: prefab.step,
                    lineWidth: prefab.lineWidth,
                });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cube') {
                const cube = prefab as unknown as CubePrefab;
                const model = this.models.createCube({ size: cube.size, textureId: (cube as any).texture, uv: cube.uv });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'plane') {
                const plane = prefab as PlanePrefab;
                const model = this.models.createPlane({
                    width: plane.width,
                    height: plane.height,
                    textureId: plane.texture,
                });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'sphere') {
                const sphere = prefab as unknown as SpherePrefab;
                const model = this.models.createSphere({ segments: sphere.segments, textureId: (sphere as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cylinder') {
                const cyl = prefab as unknown as CylinderPrefab;
                const model = this.models.createCylinder({ segments: cyl.segments, textureId: (cyl as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'cone') {
                const cone = prefab as unknown as ConePrefab;
                const model = this.models.createCone({ segments: cone.segments, textureId: (cone as any).texture });
                setPrefabHandle(prefab, model);
            } else if (prefab.type === 'mesh') {
                const meshPrefab = prefab as unknown as MeshPrefab;
                const model = this.core.models.createMesh({
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
            this.core.context.configure({
                device: this.core.device,
                format: navigator.gpu.getPreferredCanvasFormat(),
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

    createCompute(name: string, options: ComputeOptions): ComputeBuilder {
        return new ComputeBuilder(name, options, this.core.root);
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


    storePreviousState(): void {
        for (let i = 0; i < this.interpolators.length; i++) {
            this.interpolators[i]!.storePrevious();
        }
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
        const dyn = this.instances.store.dynamicData;
        const stat = this.instances.store.staticData;
        const models = this.core.models;
        this.instances.store.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.instances.store.instanceHandles[slot];
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

        const sDyn = this.instances.skinnedStore.dynamicData;
        const sStat = this.instances.skinnedStore.staticData;
        this.instances.skinnedStore.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.instances.skinnedStore.instanceHandles[slot];
                if (handle === null) continue;
                const model = models.get(handle.modelId);
                if (!model) continue;
                const skin = this.core.models.skinnedModel(model.skinIndex);
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

    /** Upload instance transforms and bone matrices, then pack the visible main-pass slot indices. */
    private uploadInstanceBuffers(): void {
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

        // Pack slot indices per model, with frustum culling
        let indexOffset = 0;
        const batchOffsets = this.batchOffsets;
        batchOffsets.length = 0;
        const dyn = this.instances.store.dynamicData;
        const stat = this.instances.store.staticData;

        this.instances.store.batcher.each((modelId, instances, count, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            const model = this.core.models.get(modelId);
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
                if (this.core.frustum.intersectsSphere(cx, cy, cz, radius)) {
                    this.instances.store.slotIndexData[indexOffset++] = slot;
                }
            }

            const visibleCount = indexOffset - batchStart;
            if (visibleCount > 0) {
                batchOffsets.push({ modelId, materialId, offset: batchStart, count: visibleCount });
            }
        });

        if (indexOffset > 0) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawSlotIndexBuffer, 0,
                this.instances.store.slotIndexData.buffer, this.instances.store.slotIndexData.byteOffset,
                indexOffset * 4,
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

        // Pack skinned slot indices
        let skinnedIndexOffset = 0;
        const skinnedBatchOffsets = this.skinnedBatchOffsets;
        skinnedBatchOffsets.length = 0;
        const sDyn = this.instances.skinnedStore.dynamicData;
        const sStat = this.instances.skinnedStore.staticData;

        this.instances.skinnedStore.batcher.each((modelId, instances, count) => {
            const model = this.core.models.get(modelId);
            if (!model) return;
            const batchStart = skinnedIndexOffset;

            // Frustum cull skinned instances using per-skin bounding radius
            const skinModel = model.skinIndex >= 0 ? this.core.models.skinnedModel(model.skinIndex) : null;
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

                if (this.core.frustum.intersectsSphere(cx, cy, cz, radius)) {
                    this.instances.skinnedStore.slotIndexData[skinnedIndexOffset++] = slot;
                }
            }

            const visibleCount = skinnedIndexOffset - batchStart;
            if (visibleCount > 0) {
                skinnedBatchOffsets.push({ modelId, offset: batchStart, count: visibleCount });
            }
        });

        if (skinnedIndexOffset > 0) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawSkinnedSlotIndexBuffer, 0,
                this.instances.skinnedStore.slotIndexData.buffer, this.instances.skinnedStore.slotIndexData.byteOffset,
                skinnedIndexOffset * 4,
            );
        }

    }

    /** Delegate each shadow pass to its manager (caster gather plus encode). */
    private renderShadowPasses(encoder: GPUCommandEncoder): void {
        this.shadows.directional.render(encoder);
        this.shadows.spot.render(encoder);
        this.shadows.point.render(encoder);
    }

    /** Pack the light buffer and write the frame uniforms. Runs after the light assignments. */
    private uploadLightsAndUniforms(alpha: number, vpMatrix: Float32Array): void {
        const packed = this.lights.pack();
        if (packed.count > 0) {
            this.core.device.queue.writeBuffer(
                this.core.pipelines.rawLightBuffer, 0,
                packed.data.buffer, packed.data.byteOffset, packed.byteLength,
            );
        }

        this.core.uniformData.set(vpMatrix, 0);
        this.core.uniformData[MESH_UNIFORM_ALPHA_OFFSET] = alpha;
        this.lights.writeUniforms(this.core.uniformData, MESH_UNIFORM_LIGHT_OFFSET, packed.count);
        const camPos = this.camera.position;
        this.core.uniformData[MESH_UNIFORM_CAMERA_OFFSET] = camPos[0];
        this.core.uniformData[MESH_UNIFORM_CAMERA_OFFSET + 1] = camPos[1];
        this.core.uniformData[MESH_UNIFORM_CAMERA_OFFSET + 2] = camPos[2];
        this.core.uniformData[MESH_UNIFORM_TIME_OFFSET] = this.elapsed;
        this.core.uniformData[MESH_UNIFORM_RESOLUTION_OFFSET] = this._width;
        this.core.uniformData[MESH_UNIFORM_RESOLUTION_OFFSET + 1] = this._height;
        this.core.device.queue.writeBuffer(
            this.core.pipelines.rawUniformBuffer, 0,
            this.core.uniformData.buffer, this.core.uniformData.byteOffset,
            this.core.uniformData.byteLength,
        );
    }

    /** Draw the batched non-skinned and skinned meshes, then debug hitboxes. */
    private renderMainPass(pass: GPURenderPassEncoder, vpMatrix: Float32Array): void {
        // --- Draw non-skinned models (pass 0: opaque, pass 1: transparent) ---
        let currentPipeline: GPURenderPipeline | null = null;

        for (let passIndex = 0; passIndex < 2; passIndex++) {
            currentPipeline = null;

            for (const batch of this.batchOffsets) {
                const model = this.core.models.get(batch.modelId);
                if (!model) continue;

                const material = batch.materialId > 0 ? this.materials.library.get(batch.materialId) : null;
                const transparent = material ? material.transparent : false;
                if ((passIndex === 1) !== transparent) continue;

                if (material) {
                    if (material.pipeline !== currentPipeline) {
                        pass.setPipeline(material.pipeline);
                        pass.setBindGroup(0, this.core.pipelines.rawBindGroup);
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
                    const slot = this.instances.store.slotIndexData[batch.offset + i];
                    if (this.instances.store.textureBindGroup(slot) !== undefined) {
                        hasCustomTex = true;
                        break;
                    }
                }

                const needsTextured = model.hasTexture || hasCustomTex;
                const pipeline = needsTextured ? this.core.pipelines.rawTexturedPipeline : this.core.pipelines.rawPipeline;
                if (pipeline !== currentPipeline) {
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.core.pipelines.rawBindGroup);
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
                const whiteBG = this.core.textures.white;
                for (let i = 0; i < batch.count; i++) {
                    const slot = this.instances.store.slotIndexData[batch.offset + i];
                    const customBG = this.instances.store.textureBindGroup(slot);
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

        for (const batch of this.skinnedBatchOffsets) {
            const model = this.core.models.get(batch.modelId);
            if (!model) continue;

            // Material support: if any instance in the batch has a compiled skinned
            // material, draw per instance (materials can differ within a batch).
            let hasMaterial = false;
            for (let i = 0; i < batch.count; i++) {
                const slot = this.instances.skinnedStore.slotIndexData[batch.offset + i];
                const mid = this.instances.skinnedStore.staticData[slot * SKINNED_STATIC_MESH_FLOATS + SSTAT_MATERIAL_ID]!;
                if (mid > 0) {
                    const m = this.materials.library.get(mid);
                    if (m && m.skinnedPipeline) { hasMaterial = true; break; }
                }
            }
            if (hasMaterial) {
                pass.setVertexBuffer(0, model.rawVertexBuffer);
                if (model.rawIndexBuffer) pass.setIndexBuffer(model.rawIndexBuffer, model.indexFormat);
                const whiteBG = this.core.textures.white;
                for (let i = 0; i < batch.count; i++) {
                    const slot = this.instances.skinnedStore.slotIndexData[batch.offset + i];
                    const mid = this.instances.skinnedStore.staticData[slot * SKINNED_STATIC_MESH_FLOATS + SSTAT_MATERIAL_ID]!;
                    const material = mid > 0 ? this.materials.library.get(mid) : null;
                    if (material && material.skinnedPipeline) {
                        pass.setPipeline(material.skinnedPipeline);
                        pass.setBindGroup(0, this.core.pipelines.rawSkinnedBindGroup);
                        pass.setBindGroup(1, material.bindGroup);
                    } else {
                        const customBG = this.instances.skinnedStore.textureBindGroup(slot);
                        const needsTex = model.hasTexture || customBG !== undefined;
                        pass.setPipeline(needsTex ? this.core.pipelines.rawSkinnedTexturedPipeline : this.core.pipelines.rawSkinnedPipeline);
                        pass.setBindGroup(0, this.core.pipelines.rawSkinnedBindGroup);
                        if (needsTex) pass.setBindGroup(1, customBG ?? model.textureBindGroup ?? whiteBG);
                    }
                    if (model.rawIndexBuffer) pass.drawIndexed(model.indexCount, 1, 0, 0, batch.offset + i);
                    else pass.draw(model.vertexCount, 1, 0, batch.offset + i);
                }
                currentPipeline = null;
                continue;
            }

            // Check for per-instance texture overrides in this batch
            let hasCustomTex = false;
            for (let i = 0; i < batch.count; i++) {
                const slot = this.instances.skinnedStore.slotIndexData[batch.offset + i];
                if (this.instances.skinnedStore.textureBindGroup(slot) !== undefined) {
                    hasCustomTex = true;
                    break;
                }
            }

            const needsTextured = model.hasTexture || hasCustomTex;
            const pipeline = needsTextured ? this.core.pipelines.rawSkinnedTexturedPipeline : this.core.pipelines.rawSkinnedPipeline;
            if (pipeline !== currentPipeline) {
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.core.pipelines.rawSkinnedBindGroup);
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
            const whiteBG = this.core.textures.white;
            for (let i = 0; i < batch.count; i++) {
                const slot = this.instances.skinnedStore.slotIndexData[batch.offset + i];
                const customBG = this.instances.skinnedStore.textureBindGroup(slot);
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

    }

    /** Draw the particle systems into the current pass. */
    private renderParticles(pass: GPURenderPassEncoder, vpMatrix: Float32Array): void {
        cameraBasis(this.camera.position, this.camera.target, this.camera.up, this._camRight, this._camUp);
        this.particles.draw(pass, vpMatrix, this._camRight, this._camUp);
    }

    /** Apply the enabled camera effects into the swapchain. */
    private renderPost(encoder: GPUCommandEncoder, swapchainView: GPUTextureView, enabledEffects: number): void {
        if (enabledEffects > 0) {
            this.cameraEffects.apply(encoder, swapchainView, this.camera.effects, this.elapsed, this._width, this._height);
        }
    }

    private drawDebugHitboxes(pass: GPURenderPassEncoder, vp: Float32Array): void {
        if (!this._prefabs) return;
        const debug = this.hitboxDebug;
        const state = this.raycast.state;
        debug.begin(vp);

        const dyn = this.instances.store.dynamicData;
        const stat = this.instances.store.staticData;
        this.instances.store.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.instances.store.instanceHandles[slot];
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

        const sDyn = this.instances.skinnedStore.dynamicData;
        const sStat = this.instances.skinnedStore.staticData;
        this.instances.skinnedStore.batcher.each((_, instances, count) => {
            for (let i = 0; i < count; i++) {
                const slot = instances[i];
                const handle = this.instances.skinnedStore.instanceHandles[slot];
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
        this.particles?.system.destroy();
        this.core.pipelines?.destroy();
        this.core.models?.destroy();
        this.core.root?.destroy();
    }
}

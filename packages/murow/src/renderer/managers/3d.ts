/**
 * Constructs and wires the renderer's managers against the shared core.
 *
 * The renderer instantiates this with its dependencies and then exposes each
 * manager as a property, so nothing backend-specific lives in the renderer.
 */
import type { Logger } from 'murow/core';
import type { AssetBucket, LayerRegistry, PrefabBucket3D } from 'murow/renderer';
import {
    InstanceManager,
    InstanceStore,
    SkinnedInstanceStore,
    MaterialManager,
    MaterialLibrary,
    IblManager,
    SkyboxManager,
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
} from './runtime';
import { TextureRegistry, ModelLibrary, SkeletalRuntime, SkinCull } from './runtime/internals';
import { MainPass, RaycastController, Raycast3D } from './runtime/internals';
import type { RendererCore } from './runtime/core';
import { DEFAULT_CAPACITIES } from './runtime/defaults';

/** Dependencies the managers need from the renderer. */
export interface RendererManagersDeps {
    core: RendererCore;
    runtime: import('./runtime/backend').RendererRuntime;
    logger: Logger;
    options: any;
    camera: () => CameraManager | undefined;
    skinCull: SkinCull;
    layers: LayerRegistry;
    maxInstances: number;
    maxSkinnedInstances: number;
    maxTotalBones: number;
    canvas: HTMLCanvasElement;
    assets: AssetBucket<'3d', any, any> | null;
    prefabs: PrefabBucket3D | null;
    elapsed(): number;
    nextDecalSeq(): number;
}

/** The renderer's managers, all bound to one core. */
export class RendererManagers {
    readonly camera!: () => CameraManager | undefined;
    readonly animation!: InstanceType<typeof SkeletalRuntime>;
    readonly materials!: MaterialManager;
    readonly ibl!: IblManager;
    readonly skybox!: SkyboxManager;
    readonly lights!: LightManager;
    readonly particles!: ParticleManager;
    readonly models!: ModelsManager;
    readonly instances!: InstanceManager;
    readonly shadows!: ShadowManager;
    readonly decals!: DecalManager;
    readonly mainPass!: MainPass;
    readonly raycast!: Raycast3D;
    readonly interpolators!: unknown[];

    constructor(private readonly deps: RendererManagersDeps) {
        const rendererOptions = this.deps.options as any;
        const maxLights = rendererOptions.maxLights ?? DEFAULT_CAPACITIES.lights;
        const shadowSystem = new ShadowSystem({
            runtime: deps.runtime,
            core: deps.core,
            maxInstances: deps.maxInstances,
            skinned: {
                maxInstances: deps.maxSkinnedInstances,
                maxBones: deps.maxTotalBones,
            },
        }, { resolution: (deps.options as any).shadowResolution ?? 2048 });

        const spotShadowSystem = new SpotShadowSystem({
            runtime: deps.runtime,
            core: deps.core,
            maxInstances: deps.maxInstances,
            skinned: {
                maxInstances: deps.maxSkinnedInstances,
                maxBones: deps.maxTotalBones,
            },
        }, { maxShadows: (deps.options as any).maxSpotShadows });

        const pointShadowSystem = new PointShadowSystem({
            runtime: deps.runtime,
            core: deps.core,
            maxInstances: deps.maxInstances,
            skinned: {
                maxInstances: deps.maxSkinnedInstances,
                maxBones: deps.maxTotalBones,
            },
        }, {
            maxShadows: (deps.options as any).maxPointShadows,
            resolution: (deps.options as any).pointShadowResolution,
        });

        deps.core.textures = new TextureRegistry(deps.core.device, deps.core.pipelines.rawTexturedPipeline.getBindGroupLayout(1));
        deps.core.textures.initWhiteFallback();
        if (deps.assets) {
            // The bucket accessor proxy binds methods per access; capture it once.
            const findTexture = deps.assets.textures.find;
            deps.core.textures.setResolver((id) => findTexture(id));
        }

        const maxParticleEmitters = rendererOptions.maxParticleEmitters ?? 64;
        const maxParticles = rendererOptions.maxParticles ?? 4096;
        const lightSystem = new LightSystem(maxLights);
        const particleSystem = new ParticleSystem3D({
            runtime: deps.runtime,
            root: deps.core.root,
            format: deps.core.format,
            maxParticles,
            maxMaterials: rendererOptions.maxParticleMaterials ?? 16,
            maxEmitters: maxParticleEmitters,
            resolveTexture: (id) => deps.core.textures.get(id),
            logger: deps.logger,
        });

        const maxMaterials = rendererOptions.maxMaterials ?? DEFAULT_CAPACITIES.materials;
        const ibl = new IblManager(deps.core.device);
        const skybox = new SkyboxManager({ runtime: deps.runtime, device: deps.core.device, format: deps.core.format, ibl });
        const materialLibrary = new MaterialLibrary({
            runtime: deps.runtime,
            root: deps.core.root,
            device: deps.core.device,
            pipelines: deps.core.pipelines,
            textures: deps.core.textures,
            meshLayout: deps.core.pipelines.meshLayout,
            skinnedLayout: deps.core.pipelines.skinnedMeshLayout,
            shadow: shadowSystem,
            spotShadow: spotShadowSystem,
            pointShadow: pointShadowSystem,
            ibl,
            maxMaterials,
        });
        // Changing `renderer.shadows.resolution` rebinds every material.
        shadowSystem.setResolutionHook(() => materialLibrary.rebuildBindGroups());
        deps.core.materialLibrary = materialLibrary;

        // Instance stores are created here so their material refcounting can
        // reach the library; the animation runtime reads the skinned store.
        const retainMaterial = (materialId: number) => materialLibrary.retain(materialId);
        const releaseMaterial = (materialId: number) => materialLibrary.release(materialId);
        const instanceStore = new InstanceStore({
            maxInstances: deps.maxInstances,
            layers: deps.layers,
            logger: deps.logger,
            getTextureBindGroup: (id) => deps.core.textures.get(id)?.bindGroup,
            retainMaterial,
            releaseMaterial,
        });
        const skinnedStore = new SkinnedInstanceStore({
            maxSkinnedInstances: deps.maxSkinnedInstances,
            maxTotalBones: deps.maxTotalBones,
            maxSkins: deps.prefabs ? deps.prefabs.size : 64,
            layers: deps.layers,
            logger: deps.logger,
            uploadRestPose: (skinModel, boneOffset, jointCount) => animation.writeRestPose(skinModel, boneOffset, jointCount),
            getTextureBindGroup: (id) => deps.core.textures.get(id)?.bindGroup,
            retainMaterial,
            releaseMaterial,
        });

        this.ibl = ibl;
        this.skybox = skybox;
        this.materials = new MaterialManager({
            capacity: maxMaterials,
            logger: deps.logger,
            library: materialLibrary,
            reassignUsers: (materialId) => this.instances?.reassignMaterial(materialId),
        });
        this.lights = new LightManager({ capacity: maxLights, logger: deps.logger, system: lightSystem });
        this.particles = new ParticleManager({
            capacity: { maxEmitters: maxParticleEmitters, maxParticles },
            logger: deps.logger,
            system: particleSystem,
        });

        const animation = new SkeletalRuntime({
            runtime: deps.runtime,
            root: deps.core.root,
            device: deps.core.device,
            pipelines: deps.core.pipelines,
            skinned: skinnedStore,
            camera: deps.camera,
            skinCull: deps.skinCull,
            maxSkinnedInstances: deps.maxSkinnedInstances,
            maxTotalBones: deps.maxTotalBones,
            maxSkins: deps.prefabs ? deps.prefabs.size : 64,
            getModel: (id) => deps.core.models.get(id),
            getSkinModel: (i) => deps.core.models.skinnedModel(i),
            skinnedModelCount: () => deps.core.models.skinnedModelCount(),
        });
        this.animation = animation;

        deps.core.models = new ModelLibrary({
            device: deps.core.device,
            pipelines: deps.core.pipelines,
            textures: deps.core.textures,
            onSkinLoaded: (skinData, animClips) => animation.addSkin(skinData, animClips),
        });
        this.models = new ModelsManager(deps.core, animation);

        this.instances = new InstanceManager({
            capacity: deps.maxInstances,
            poolSize: deps.maxInstances + deps.maxSkinnedInstances,
            logger: deps.logger,
            store: instanceStore,
            skinned: skinnedStore,
            models: deps.core.models,
            prefabs: deps.prefabs,
            layers: deps.layers,
            getSkinModel: (index) => deps.core.models.skinnedModel(index),
            materialName: (id) => materialLibrary.nameOf(id),
        });
        this.raycast = new Raycast3D(new RaycastController({
            camera: deps.camera,
            eachInstance: this.instances.eachInstance.bind(this.instances),
            resolveHitbox: this.instances.resolveHitbox.bind(this.instances),
            layerOf: this.instances.layerOf.bind(this.instances),
        }), deps.canvas);
        this.shadows = new ShadowManager({
            directional: shadowSystem,
            spot: spotShadowSystem,
            point: pointShadowSystem,
            instances: this.instances,
            materials: this.materials,
            lights: this.lights,
            camera: deps.camera,
            core: deps.core,
            motionVersion: () => this.instances.store.dynamicVersion + this.instances.skinnedStore.dynamicVersion + animation.version,
        });
        this.decals = new DecalManager({
            capacity: rendererOptions.maxDecals ?? 16,
            logger: deps.logger,
            createMaterial: (spec) => this.materials.create({
                ...spec,
                name: spec.name ?? `__decal_${deps.nextDecalSeq()}`,
            }) as never,
            addDecalInstance: (prefab, material) => this.instances!.add({
                prefab,
                position: [0, -10000, 0],
                scale: 0.001,
                material,
            }) as never,
            elapsedSeconds: () => deps.elapsed(),
        });

        // Snapshot order is irrelevant; the three snapshots are independent.
        this.interpolators = [this.instances, this.lights];

        this.mainPass = new MainPass(deps.core, this.instances, this.materials);
    }
}

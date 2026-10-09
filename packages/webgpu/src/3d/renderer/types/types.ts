/**
 * WebGPU3DRenderer public types — handles (see `handles.ts`) and renderer options.
 */
import type {
    AssetBucket,
    Renderer3DOptions,
    TextureSpec,
    Prefab3DSpec,
    Prefab3D,
    TexturePrefab,
    Raycast as RaycastBase,
    RaycastMemo as RaycastMemoBase,
    RaycastHit as RaycastHitBase,
    RaycastOptions as RaycastOptionsBase,
} from 'murow/renderer';
import type { Logger } from 'murow/core';
import type { Handles } from '../handles';
import type { MaterialHandle } from '../managers/materials';

export type ModelHandle = Handles.ModelHandle;
export type GltfModel = Handles.GltfModel;
export type MeshInstanceHandle = Handles.MeshInstanceHandle;
export type InstanceHandle = Handles.InstanceHandle;
export type LightHandle = Handles.LightHandle;

export interface ModelData {
    positions: Float32Array;
    normals?: Float32Array;
    uvs?: Float32Array;
    indices?: Uint16Array | Uint32Array;
    texture?: ImageBitmap;
}

type TextureIdsOf<A> =
    A extends AssetBucket<'3d', infer TexSpecs extends Record<string, TextureSpec>, any>
        ? keyof TexSpecs
        : string;
type PrefabsIdsOf<A> =
    A extends AssetBucket<'3d', any, infer PrefabSpecs extends Record<string, Prefab3DSpec>>
        ? keyof PrefabSpecs
        : string;
type StringOr<T extends string> = T | (string & {});

interface MeshInstance<A extends AssetBucket<'3d', any, any>> {
    /**
     * Prefab (ID or from bucket) or raw model handle to spawn. If a prefab, the renderer
     * will look up the GPU handle for it and spawn all its parts. If a raw model handle, the
     * renderer will spawn just that single part.
     */
    prefab: StringOr<PrefabsIdsOf<A>> | ModelHandle | GltfModel | Prefab3D;

    /**
     * Optional texture override. If a prefab, the renderer will look up the GPU handle for
     * it and use that texture for all parts of the prefab. If a raw model handle, the
     * renderer will use that texture for that single part. If omitted, the prefab's default
     * texture is used.
     */
    texture?: StringOr<TextureIdsOf<A>> | TexturePrefab;

    /** Material to render this instance with. Defaults to the engine material. */
    material?: MaterialHandle<any>;
    /**
     * Materials to render this instance with (drawn once per material). An
     * array, or a record of role name -> material. `material` is shorthand for
     * a single-element list; both may be combined.
     */
    materials?: readonly MaterialHandle<any, any>[] | Record<string, MaterialHandle<any, any>>;
}

export interface MeshInstanceOptions<A extends AssetBucket<'3d', any, any> = AssetBucket<'3d', any, any>> extends MeshInstance<A> {
    /** World position. Defaults to `[0, 0, 0]`. */
    position?: readonly [x: number, y: number, z: number];
    /** Euler rotation in radians. Defaults to `[0, 0, 0]`. */
    rotation?: readonly [x: number, y: number, z: number];
    /** Per-axis scale. Pass a single number to scale uniformly. Defaults to `[1, 1, 1]`. */
    scale?: number | readonly [x: number, y: number, z: number];
    /** Tint color RGB. Defaults to `[1, 1, 1]`. */
    color?: readonly [r: number, g: number, b: number];
}

export type RaycastHit = RaycastHitBase<MeshInstanceHandle, [number, number, number]>;
export type RaycastOptions = RaycastOptionsBase<MeshInstanceHandle>;
export type Raycast = RaycastBase<MeshInstanceHandle, [number, number, number]>;
export type RaycastMemo = RaycastMemoBase<MeshInstanceHandle, [number, number, number]>;

export interface WebGPU3DRendererOptions<A extends AssetBucket<'3d', any, any> = AssetBucket<'3d', any, any>> extends Renderer3DOptions {
    maxSkinnedInstances?: number;
    maxBonesPerSkin?: number;
    /** Max simultaneously live dynamic lights. Defaults to 64. */
    maxLights?: number;
    /** Max simultaneously created materials. Defaults to 64. */
    maxMaterials?: number;
    /** Max decal layers. Defaults to 16. */
    maxDecals?: number;
    /**
     * Max camera effects in `renderer.camera.effects`. Bounds the effect-id
     * pool and the off-screen pass count. Defaults to 20.
     */
    maxCameraEffects?: number;
    /**
     * Max live 3D particles (rounded up to a power of two). Defaults to 4096.
     */
    maxParticles?: number;
    /** Max distinct particle materials. Defaults to 16. */
    maxParticleMaterials?: number;
    /** Max live particle emitters. Defaults to 64. */
    maxParticleEmitters?: number;
    /** Directional shadow map resolution (square). Defaults to 2048. */
    shadowResolution?: number;
    /** Max casting spot lights per frame. Defaults to 4. */
    maxSpotShadows?: number;
    /** Max casting point lights per frame (cube maps). Defaults to 2. */
    maxPointShadows?: number;
    /** Point-light shadow cube face resolution. Defaults to 512. */
    pointShadowResolution?: number;
    /**
     * Upper bound on internal render resolution relative to CSS pixels (caps
     * `devicePixelRatio`, default uncapped). `1.5` is a good HiDPI trade-off;
     * post-processing and shadows scale with this, so capping is the cheapest
     * large performance win.
     */
    maxPixelRatio?: number;
    /**
     * Development diagnostics. `true` routes warnings to the console with a
     * `[murow]` prefix; pass a `Logger` to route them yourself.
     */
    debug?: boolean | Logger;
    /**
     * Pre-loaded AssetBucket. When provided, the renderer uploads every
     * prefab (glTF, grid, cube, plane) and texture to the GPU during
     * `init()`. The bucket must have `load()` resolved before being passed in.
     *
     * `maxInstances` defaults to `assets.prefabs.size + 16`.
     * `maxSkinnedInstances` defaults to `maxInstances * maxSkinnedPartsPerPrefab`.
     * `maxBonesPerSkin` defaults to the maximum joint count across all prefabs.
     */
    assets?: A;
    /**
     * Max distance (world units) at which skeletal animation is computed for
     * skinned instances. Past this, instances still render but reuse their
     * last bone matrices; their internal animation clocks keep ticking on
     * CPU. See `renderer.setAnimationCullDistance` to change at runtime.
     * Set to `Infinity` to disable. Default 50.
     */
    animationCullDistance?: number;
}

/**
 * A subsystem whose simulated state is snapshotted before each tick so the
 * renderer can interpolate between the previous and current frames.
 *
 * Implemented by the camera, the instance pool and the light manager. The
 * renderer holds an explicit list and calls `storePrevious()` on pre-tick.
 */
export interface Interpolator {
    /** @internal Snapshot curr into prev. Called by the renderer on pre-tick. */
    storePrevious(): void;
}

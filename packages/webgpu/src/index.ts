/**
 * @murow/webgpu — WebGPU rendering backend for murow.
 *
 * This package supplies the **concrete WebGPU renderers** (2D + 3D), camera
 * implementations, and the GPU-bound pieces (textures, compute, geometry
 * builders, TypeGPU shader authoring).
 *
 * Renderer-agnostic primitives — `PrefabBucket`, parsers, skeletal animation,
 * spritesheet helpers — live in the top-level `murow` package and should be
 * imported from there.
 */

// TypeGPU re-exports — bundler-safe wraps (see ./shaders/typegpu.ts).
export { d, std } from './shaders/typegpu';

// 2D Renderer
export { WebGPU2DRenderer } from './2d/renderer';
export type { WebGPU2DRendererOptions } from './2d/renderer';
export { SpriteAccessor } from './2d/sprite-accessor';
export { AnimationController } from './2d/animation';
export type { AnimationClip, AnimationState, AnimationClipConfig } from './2d/animation';

// 3D Renderer
export { WebGPU3DRenderer } from './3d/renderer';
export type {
    ModelData,
    ModelHandle,
    GltfModel,
    InstanceHandle,
    MeshInstanceHandle,
    MeshInstanceOptions,
} from './3d/renderer';
export { MorphAnimation } from './3d/morph-animation';
export type { MorphClip, MorphState, MorphClipConfig } from './3d/morph-animation';

// Camera
export { Camera2D } from './camera/camera-2d';
export { Camera3D } from './camera/camera-3d';

// Geometry
export {
    GeometryBuilder,
    CustomGeometry,
    InstanceAccessor,
    InstanceContext,
    getFieldFloats,
    createGeometryDataLayout,
} from './geometry/geometry-builder';
export type {
    GeometryOptions,
    InstanceLayoutConfig,
    CustomGeometryLayout,
    GeometryDataLayout,
    ShaderContext,
} from './geometry/geometry-builder';
export { resolveBuiltInGeometry } from './geometry/built-in';
export type { BuiltInGeometry, GeometryData } from './geometry/built-in';

// Spritesheet — GPU-bound types and helpers.
// Pure UV math / image loading live in `murow` (re-exported via the renderer module).
export { Spritesheet, createTextureFromBitmap } from './spritesheet/spritesheet';

// Particle
export { ParticleEmitter } from './particle/emitter';
export type { ParticleEmitterConfig, Range } from './particle/emitter';

// Compute
export { ComputeBuilder, ComputeKernel } from './compute/compute-builder';
export type { ComputeOptions, ComputeBufferDef, ComputeInput } from './compute/compute-builder';

// Shader utilities
export { rotate2d, worldToClip2d, worldToClip3d, remap, scaleRotate2d, inverseLerp } from './shaders/utils';

// Core
export * from './core/constants';
export {
    DynamicSprite,
    StaticSprite,
    SpriteUniforms,
    DynamicInstance3D,
    StaticInstance3D,
    DynamicMesh,
    StaticMesh,
    SkinnedStaticMesh,
    MeshUniforms,
} from './core/types';

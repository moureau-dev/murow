/**
 * @murow/webgpu — WebGPU rendering backend for murow.
 *
 * Re-exports TypeGPU's data module as `d` for user-facing shader authoring.
 */

// TypeGPU re-exports
export * as d from 'typegpu/data';
export * as std from 'typegpu/std';

// 2D Renderer
export { WebGPU2DRenderer } from './2d/renderer';
export { SpriteAccessor } from './2d/sprite-accessor';

// 3D Renderer
export { WebGPU3DRenderer } from './3d/renderer';
export type { ModelHandle, MeshInstanceHandle, MeshInstanceOptions } from './3d/renderer';
export { MorphAnimation } from './3d/morph-animation';
export type { MorphClip, MorphState, MorphClipConfig } from './3d/morph-animation';

// Camera
export { Camera2D } from './camera/camera-2d';
export { Camera3D } from './camera/camera-3d';

// Geometry
export { GeometryBuilder, CustomGeometry, InstanceAccessor, InstanceContext, getFieldFloats, createGeometryDataLayout } from './geometry/geometry-builder';
export type { GeometryOptions, InstanceLayoutConfig, CustomGeometryLayout, GeometryDataLayout } from './geometry/geometry-builder';
export { resolveBuiltInGeometry } from './geometry/built-in';
export type { BuiltInGeometry, GeometryData } from './geometry/built-in';

// Spritesheet
export { Spritesheet, computeGridUVs, computeTexturePackerUVs, loadImage, createTextureFromBitmap } from './spritesheet/spritesheet';
export type { SpritesheetConfig, TexturePackerData } from './spritesheet/spritesheet';

// Particle
export { ParticleEmitter } from './particle/emitter';
export type { ParticleEmitterConfig, Range } from './particle/emitter';

// Animation (2D)
export { AnimationController } from './2d/animation';
export type { AnimationClip, AnimationState, AnimationClipConfig } from './2d/animation';

// Shader utilities
export { rotate2d, worldToClip2d, worldToClip3d, remap, scaleRotate2d, inverseLerp } from './shaders/utils';

// Core
export * from './core/constants';
export { DynamicSprite, StaticSprite, SpriteUniforms, DynamicInstance3D, StaticInstance3D, DynamicMesh, StaticMesh, MeshUniforms } from './core/types';

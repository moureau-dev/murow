/**
 * TypeGPU struct definitions for the 2D and 3D renderers.
 * These define the GPU-side data layout — used by shaders and bind group layouts.
 *
 * All fields are f32 to guarantee contiguous layout matching our flat Float32Arrays.
 * No vec2f/vec4f here — that would introduce alignment padding.
 */
import * as d from 'typegpu/data';

// --- 2D Sprite Instance Data ---

export const DynamicSprite = d.struct({
    prevX: d.f32,
    prevY: d.f32,
    currX: d.f32,
    currY: d.f32,
    prevRotation: d.f32,
    currRotation: d.f32,
});

export const StaticSprite = d.struct({
    scaleX: d.f32,
    scaleY: d.f32,
    uvMinX: d.f32,
    uvMinY: d.f32,
    uvMaxX: d.f32,
    uvMaxY: d.f32,
    layer: d.f32,
    flipX: d.f32,
    flipY: d.f32,
    opacity: d.f32,
    tintR: d.f32,
    tintG: d.f32,
    tintB: d.f32,
    tintA: d.f32,
});

export const SpriteUniforms = d.struct({
    viewProjection: d.mat3x3f,
    alpha: d.f32,
    resolution: d.vec2f,
});

// --- 3D Instance Data ---

export const DynamicInstance3D = d.struct({
    prevPosX: d.f32,
    prevPosY: d.f32,
    prevPosZ: d.f32,
    currPosX: d.f32,
    currPosY: d.f32,
    currPosZ: d.f32,
    prevRotX: d.f32,
    prevRotY: d.f32,
    prevRotZ: d.f32,
    prevRotW: d.f32,
    currRotX: d.f32,
    currRotY: d.f32,
    currRotZ: d.f32,
    currRotW: d.f32,
});

export const StaticInstance3D = d.struct({
    scaleX: d.f32,
    scaleY: d.f32,
    scaleZ: d.f32,
    materialId: d.f32,
    opacity: d.f32,
    tintR: d.f32,
    tintG: d.f32,
    tintB: d.f32,
    tintA: d.f32,
    custom0: d.f32,
    custom1: d.f32,
});

// --- 3D Euler-based Instance Data (simpler, for common use) ---

export const DynamicMesh = d.struct({
    prevPosX: d.f32,
    prevPosY: d.f32,
    prevPosZ: d.f32,
    currPosX: d.f32,
    currPosY: d.f32,
    currPosZ: d.f32,
    prevRotX: d.f32,
    prevRotY: d.f32,
    prevRotZ: d.f32,
    currRotX: d.f32,
    currRotY: d.f32,
    currRotZ: d.f32,
});

export const DYNAMIC_MESH_FLOATS = 12;

export const StaticMesh = d.struct({
    scaleX: d.f32,
    scaleY: d.f32,
    scaleZ: d.f32,
    colorR: d.f32,
    colorG: d.f32,
    colorB: d.f32,
});

export const STATIC_MESH_FLOATS = 6;

// --- 3D Skinned Instance Data (adds bone offset for skeletal animation) ---

export const SkinnedStaticMesh = d.struct({
    scaleX: d.f32,
    scaleY: d.f32,
    scaleZ: d.f32,
    colorR: d.f32,
    colorG: d.f32,
    colorB: d.f32,
    boneOffset: d.u32,
});

export const SKINNED_STATIC_MESH_FLOATS = 7;

export const MeshUniforms = d.struct({
    viewProjection: d.mat4x4f,
    alpha: d.f32,
    lightDirX: d.f32,
    lightDirY: d.f32,
    lightDirZ: d.f32,
});

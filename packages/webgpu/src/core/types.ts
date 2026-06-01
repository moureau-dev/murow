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
    lightDirR: d.f32,
    lightDirG: d.f32,
    lightDirB: d.f32,
    lightDirIntensity: d.f32,
    ambientR: d.f32,
    ambientG: d.f32,
    ambientB: d.f32,
    lightCount: d.u32,
});

// Float offsets into MeshUniforms, named so the renderer never hard-codes them.
/** viewProjection occupies floats [0, 16). */
export const MESH_UNIFORM_ALPHA_OFFSET = 16;
/** The directional/ambient/count block starts right after `alpha`. */
export const MESH_UNIFORM_LIGHT_OFFSET = 17;
/** Total f32 slots in MeshUniforms (mat4x4 16 + alpha 1 + 10 light terms + count 1). */
export const MESH_UNIFORM_FLOATS = 28;

// --- 3D Dynamic Lights ---

/**
 * Point/spot light record. One entry per slot in the renderer's light storage
 * buffer; the fragment shader loops `[0, lightCount)`. Kept f32-contiguous (no
 * vec types) to match the flat Float32Array the renderer uploads.
 *
 * Position and direction carry `prev` + `curr` snapshots so the fragment shader
 * can `mix(prev, curr, alpha)`, moving lights interpolate at render rate, the
 * same as mesh instances, instead of snapping at the tick boundary.
 *
 * `kind`: 1 = point, 2 = spot (0/directional is the global term in MeshUniforms).
 * `castsShadow` / `shadowMapIndex` are reserved for shadow-map support: the
 * fragment loop already multiplies each light by a shadow factor (currently
 * 1.0), so a shadow pass can populate these without reshaping the buffer.
 */
export const Light = d.struct({
    kind: d.f32,
    currPosX: d.f32,
    currPosY: d.f32,
    currPosZ: d.f32,
    prevPosX: d.f32,
    prevPosY: d.f32,
    prevPosZ: d.f32,
    currDirX: d.f32,
    currDirY: d.f32,
    currDirZ: d.f32,
    prevDirX: d.f32,
    prevDirY: d.f32,
    prevDirZ: d.f32,
    colorR: d.f32,
    colorG: d.f32,
    colorB: d.f32,
    intensity: d.f32,
    range: d.f32,
    innerCos: d.f32,
    outerCos: d.f32,
    castsShadow: d.f32,
    shadowMapIndex: d.f32,
});

export const LIGHT_FLOATS = 22;

export const LIGHT_KIND_POINT = 1;
export const LIGHT_KIND_SPOT = 2;

// --- GPU Skeletal Animation Structs ---

/** Per-instance animation state, uploaded from CPU each frame. */
export const InstanceAnimStateGPU = d.struct({
    clipId: d.i32,
    time: d.f32,
    skinIndex: d.u32,
    boneOffset: d.u32,
    prevClipId: d.i32,
    prevTime: d.f32,
    blendWeight: d.f32,
    _pad: d.f32,
});

/** Uniforms for the animation compute shader. */
export const AnimComputeUniforms = d.struct({
    instanceCount: d.u32,
    clipTableOffset: d.u32,
    channelTableOffset: d.u32,
    jointLookupOffset: d.u32,
});

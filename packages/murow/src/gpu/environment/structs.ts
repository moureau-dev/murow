/**
 * Struct schemas for the built-in shader environment.
 *
 * These mirror the uniform and storage layouts the engine uploads. Field names,
 * order, and types match the renderer's flat Float32 buffers exactly, so a
 * shader authored against these schemas reads the same bytes.
 */
import { f32, gpuStruct, mat4x4f, u32 } from '../schema';

/** Per-view uniforms shared by every mesh draw. */
export const MeshUniforms = gpuStruct({
    name: 'MeshUniforms',
    fields: {
        viewProjection: mat4x4f,
        alpha: f32,
        lightDirX: f32,
        lightDirY: f32,
        lightDirZ: f32,
        lightDirR: f32,
        lightDirG: f32,
        lightDirB: f32,
        lightDirIntensity: f32,
        ambientR: f32,
        ambientG: f32,
        ambientB: f32,
        lightCount: u32,
        cameraX: f32,
        cameraY: f32,
        cameraZ: f32,
        time: f32,
        resolutionX: f32,
        resolutionY: f32,
    },
});

/** Material uniforms shared by every engine material. */
export const EngineMaterialUniforms = gpuStruct({
    name: 'EngineMaterialUniforms',
    fields: {
        colorR: f32,
        colorG: f32,
        colorB: f32,
        opacity: f32,
        emissive: f32,
        alphaTest: f32,
        uvScaleU: f32,
        uvScaleV: f32,
        uvOffsetU: f32,
        uvOffsetV: f32,
        receiveShadow: f32,
        extrude: f32,
    },
});

/** One point or spot light. */
export const Light = gpuStruct({
    name: 'Light',
    fields: {
        kind: f32,
        currPosX: f32,
        currPosY: f32,
        currPosZ: f32,
        prevPosX: f32,
        prevPosY: f32,
        prevPosZ: f32,
        currDirX: f32,
        currDirY: f32,
        currDirZ: f32,
        prevDirX: f32,
        prevDirY: f32,
        prevDirZ: f32,
        colorR: f32,
        colorG: f32,
        colorB: f32,
        intensity: f32,
        range: f32,
        innerCos: f32,
        outerCos: f32,
        castsShadow: f32,
        shadowMapIndex: f32,
    },
});

/** Per-instance animation state for meshes. */
export const DynamicMesh = gpuStruct({
    name: 'DynamicMesh',
    fields: {
        prevPosX: f32,
        prevPosY: f32,
        prevPosZ: f32,
        currPosX: f32,
        currPosY: f32,
        currPosZ: f32,
        prevRotX: f32,
        prevRotY: f32,
        prevRotZ: f32,
        currRotX: f32,
        currRotY: f32,
        currRotZ: f32,
    },
});

/** Static per-instance mesh state. */
export const StaticMesh = gpuStruct({
    name: 'StaticMesh',
    fields: {
        scaleX: f32,
        scaleY: f32,
        scaleZ: f32,
        colorR: f32,
        colorG: f32,
        colorB: f32,
        materialId: f32,
        custom0: f32,
        custom1: f32,
    },
});

/** Static per-instance state for skinned meshes. */
export const SkinnedStaticMesh = gpuStruct({
    name: 'SkinnedStaticMesh',
    fields: {
        scaleX: f32,
        scaleY: f32,
        scaleZ: f32,
        colorR: f32,
        colorG: f32,
        colorB: f32,
        boneOffset: u32,
        materialId: f32,
    },
});

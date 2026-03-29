/**
 * Game-specific TGSL shader utilities.
 *
 * These are `tgpu.fn` functions usable inside vertex/fragment shaders.
 * For standard math (sin, cos, pow, mix, etc.) use `std` from 'typegpu/std'.
 */
import tgpu from 'typegpu';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';

/**
 * Rotate a 2D point around the origin by `angle` radians.
 */
export const rotate2d = tgpu.fn([d.vec2f, d.f32], d.vec2f)(
    function rotate2d(point: d.v2f, angle: number) {
        'use gpu';
        const c = std.cos(angle);
        const s = std.sin(angle);
        return d.vec2f(
            point.x * c - point.y * s,
            point.x * s + point.y * c,
        );
    },
);

/**
 * Transform a 2D world position to clip space using a 3x3 camera matrix
 * (stored as mat3x3f). Returns vec4f for vertex output.
 */
export const worldToClip2d = tgpu.fn([d.vec2f, d.mat3x3f], d.vec4f)(
    function worldToClip2d(worldPos: d.v2f, cameraMatrix: d.m3x3f) {
        'use gpu';
        // @ts-ignore — TGSL: matrix * vector is valid in WGSL, transpiled by TypeGPU
        const clip = cameraMatrix * d.vec3f(worldPos.x, worldPos.y, 1.0);
        return d.vec4f((clip as any).x, (clip as any).y, 0.0, 1.0);
    },
);

/**
 * Transform a 3D world position to clip space using a 4x4 view-projection matrix.
 */
export const worldToClip3d = tgpu.fn([d.vec3f, d.mat4x4f], d.vec4f)(
    function worldToClip3d(worldPos: d.v3f, vpMatrix: d.m4x4f) {
        'use gpu';
        // @ts-ignore — TGSL: matrix * vector is valid in WGSL, transpiled by TypeGPU
        return vpMatrix * d.vec4f(worldPos.x, worldPos.y, worldPos.z, 1.0) as unknown as d.v4f;
    },
);

/**
 * Remap a value from one range to another.
 * `remap(0.5, 0, 1, 10, 20)` returns `15`.
 */
export const remap = tgpu.fn([d.f32, d.f32, d.f32, d.f32, d.f32], d.f32)(
    function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
        'use gpu';
        const t = (value - inMin) / (inMax - inMin);
        return outMin + t * (outMax - outMin);
    },
);

/**
 * Compute a 2D scale+rotation matrix from scale and angle.
 * Useful for sprite transforms in the vertex shader.
 */
export const scaleRotate2d = tgpu.fn([d.vec2f, d.f32], d.mat2x2f)(
    function scaleRotate2d(scale: d.v2f, angle: number) {
        'use gpu';
        const c = std.cos(angle);
        const s = std.sin(angle);
        return d.mat2x2f(
            scale.x * c, scale.x * s,
            -(scale.y * s), scale.y * c,
        );
    },
);

/**
 * Inverse lerp — given a value in [min, max], returns its t in [0, 1].
 */
export const inverseLerp = tgpu.fn([d.f32, d.f32, d.f32], d.f32)(
    function inverseLerp(min: number, max: number, value: number) {
        'use gpu';
        return std.saturate((value - min) / (max - min));
    },
);

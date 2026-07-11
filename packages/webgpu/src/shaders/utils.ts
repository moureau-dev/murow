/**
 * Game-specific TGSL shader utilities.
 *
 * These are `tgpu.fn` functions usable inside vertex/fragment shaders.
 * For standard math (sin, cos, pow, mix, etc.) use `std` from 'typegpu/std'.
 */
import tgpu from 'typegpu';
import { attachShaderMetadata } from './runtime-transpile';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';

/**
 * Rotate a 2D point around the origin by `angle` radians.
 */
const rotate2dFn = function rotate2d(point: d.v2f, angle: number) {
    'use gpu';
    const c = std.cos(angle);
    const s = std.sin(angle);
    return d.vec2f(
        point.x * c - point.y * s,
        point.x * s + point.y * c,
    );
};
attachShaderMetadata(
    rotate2dFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function rotate2d(point, angle) {
    const c = std.cos(angle);
    const s = std.sin(angle);
    return d.vec2f(
        point.x * c - point.y * s,
        point.x * s + point.y * c,
    );
}`,
);
export const rotate2d = tgpu.fn([d.vec2f, d.f32], d.vec2f)(rotate2dFn as any);

/**
 * Transform a 2D world position to clip space using a 3x3 camera matrix
 * (stored as mat3x3f). Returns vec4f for vertex output.
 */
const worldToClip2dFn = function worldToClip2d(worldPos: d.v2f, cameraMatrix: d.m3x3f) {
    'use gpu';
    // @ts-ignore — TGSL: matrix * vector is valid in WGSL, transpiled by TypeGPU
    const clip = cameraMatrix * d.vec3f(worldPos.x, worldPos.y, 1.0);
    return d.vec4f((clip as any).x, (clip as any).y, 0.0, 1.0);
};
attachShaderMetadata(
    worldToClip2dFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function worldToClip2d(worldPos, cameraMatrix) {
    const clip = cameraMatrix * d.vec3f(worldPos.x, worldPos.y, 1.0);
    return d.vec4f(clip.x, clip.y, 0.0, 1.0);
}`,
);
export const worldToClip2d = tgpu.fn([d.vec2f, d.mat3x3f], d.vec4f)(worldToClip2dFn as any);

/**
 * Transform a 3D world position to clip space using a 4x4 view-projection matrix.
 */
const worldToClip3dFn = function worldToClip3d(worldPos: d.v3f, vpMatrix: d.m4x4f) {
    'use gpu';
    // @ts-ignore — TGSL: matrix * vector is valid in WGSL, transpiled by TypeGPU
    return vpMatrix * d.vec4f(worldPos.x, worldPos.y, worldPos.z, 1.0) as unknown as d.v4f;
};
attachShaderMetadata(
    worldToClip3dFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function worldToClip3d(worldPos, vpMatrix) {
    return vpMatrix * d.vec4f(worldPos.x, worldPos.y, worldPos.z, 1.0);
}`,
);
export const worldToClip3d = tgpu.fn([d.vec3f, d.mat4x4f], d.vec4f)(worldToClip3dFn as any);

/**
 * Remap a value from one range to another.
 * `remap(0.5, 0, 1, 10, 20)` returns `15`.
 */
const remapFn = function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
    'use gpu';
    const t = (value - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
};
attachShaderMetadata(
    remapFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function remap(value, inMin, inMax, outMin, outMax) {
    const t = (value - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
}`,
);
export const remap = tgpu.fn([d.f32, d.f32, d.f32, d.f32, d.f32], d.f32)(remapFn as any);

/**
 * Compute a 2D scale+rotation matrix from scale and angle.
 * Useful for sprite transforms in the vertex shader.
 */
const scaleRotate2dFn = function scaleRotate2d(scale: d.v2f, angle: number) {
    'use gpu';
    const c = std.cos(angle);
    const s = std.sin(angle);
    return d.mat2x2f(
        scale.x * c, scale.x * s,
        -(scale.y * s), scale.y * c,
    );
};
attachShaderMetadata(
    scaleRotate2dFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function scaleRotate2d(scale, angle) {
    const c = std.cos(angle);
    const s = std.sin(angle);
    return d.mat2x2f(
        scale.x * c, scale.x * s,
        -(scale.y * s), scale.y * c,
    );
}`,
);
export const scaleRotate2d = tgpu.fn([d.vec2f, d.f32], d.mat2x2f)(scaleRotate2dFn as any);

/**
 * Inverse lerp — given a value in [min, max], returns its t in [0, 1].
 */
const inverseLerpFn = function inverseLerp(min: number, max: number, value: number) {
    'use gpu';
    return std.saturate((value - min) / (max - min));
};
attachShaderMetadata(
    inverseLerpFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function inverseLerp(min, max, value) {
    return std.saturate((value - min) / (max - min));
}`,
);
export const inverseLerp = tgpu.fn([d.f32, d.f32, d.f32], d.f32)(inverseLerpFn as any);

/**
 * Diffuse contribution of one point/spot light at a surface point. Returns the
 * light's color scaled by Lambert term, distance attenuation, spot cone, and a
 * shadow factor. The shadow factor is currently fixed at 1.0; a shadow-map pass
 * replaces it by sampling the light's shadow map without changing this loop.
 *
 * Takes the light's fields as vectors (rather than the `Light` struct) so the
 * signature is portable across the mesh and skinned fragment shaders, which
 * each read the struct from their own bind-group storage buffer:
 *   `pos`      light position (point/spot)
 *   `axis`     spot direction (unused for point lights)
 *   `color`    light rgb
 *   `params`   (intensity, range, innerCos, outerCos); a point light passes
 *              innerCos = 1, outerCos = -1 so the cone term is always 1.
 *   `normal`   surface normal (world space, normalized)
 *   `worldPos` surface position (world space)
 */
const lightContributionFn = function lightContribution(pos: d.v3f, axis: d.v3f, color: d.v3f, params: d.v4f, normal: d.v3f, worldPos: d.v3f) {
    'use gpu';
    const intensity = params.x;
    const range = params.y;
    const innerCos = params.z;
    const outerCos = params.w;

    const toLight = d.vec3f(pos.x - worldPos.x, pos.y - worldPos.y, pos.z - worldPos.z);
    const dist = std.length(toLight);
    const dir = std.normalize(toLight);

    const lambert = std.max(std.dot(normal, dir), 0.0);

    // Smooth range falloff: 1 at the source, 0 at range.
    const atten = std.saturate(1.0 - dist / std.max(range, 0.0001));
    const falloff = atten * atten;

    // Spot cone: smoothstep-feathered falloff from outerCos (edge, 0) to innerCos (full, 1).
    const axisLen = std.length(axis);
    const isSpot = axisLen > 0.0001;
    const safeAxis = std.select(d.vec3f(0.0, 0.0, 1.0), axis, isSpot);
    const cosAngle = std.dot(std.normalize(safeAxis), d.vec3f(-dir.x, -dir.y, -dir.z));
    const spotCone = std.smoothstep(outerCos, innerCos, cosAngle);
    const cone = std.select(1.0, spotCone, isSpot);

    const shadowFactor = d.f32(1.0);
    const scale = lambert * falloff * cone * intensity * shadowFactor;
    return d.vec3f(color.x * scale, color.y * scale, color.z * scale);
};
attachShaderMetadata(
    lightContributionFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function lightContribution(pos, axis, color, params, normal, worldPos) {
    const intensity = params.x;
    const range = params.y;
    const innerCos = params.z;
    const outerCos = params.w;

    const toLight = d.vec3f(pos.x - worldPos.x, pos.y - worldPos.y, pos.z - worldPos.z);
    const dist = std.length(toLight);
    const dir = std.normalize(toLight);

    const lambert = std.max(std.dot(normal, dir), 0.0);

    const atten = std.saturate(1.0 - dist / std.max(range, 0.0001));
    const falloff = atten * atten;

    const axisLen = std.length(axis);
    const isSpot = axisLen > 0.0001;
    const safeAxis = std.select(d.vec3f(0.0, 0.0, 1.0), axis, isSpot);
    const cosAngle = std.dot(std.normalize(safeAxis), d.vec3f(-dir.x, -dir.y, -dir.z));
    const spotCone = std.smoothstep(outerCos, innerCos, cosAngle);
    const cone = std.select(1.0, spotCone, isSpot);

    const shadowFactor = d.f32(1.0);
    const scale = lambert * falloff * cone * intensity * shadowFactor;
    return d.vec3f(color.x * scale, color.y * scale, color.z * scale);
}`,
);
export const lightContribution = tgpu.fn(
    [d.vec3f, d.vec3f, d.vec3f, d.vec4f, d.vec3f, d.vec3f],
    d.vec3f,
)(lightContributionFn as any);

/**
 * Reinhard tone map: rolls accumulated light smoothly toward white instead of
 * hard-clipping at 1.0. Without it, summed lights flat-top to white and any
 * gradient (e.g. a feathered spot edge) collapses into a thin visible ring.
 */
const tonemapFn = function tonemap(c: d.v3f) {
    'use gpu';
    return d.vec3f(c.x / (1.0 + c.x), c.y / (1.0 + c.y), c.z / (1.0 + c.z));
};
attachShaderMetadata(
    tonemapFn,
    () => ({ d, std }),
    false,
    { d, std },
    `function tonemap(c) {
    return d.vec3f(c.x / (1.0 + c.x), c.y / (1.0 + c.y), c.z / (1.0 + c.z));
}`,
);
export const tonemap = tgpu.fn([d.vec3f], d.vec3f)(tonemapFn as any);

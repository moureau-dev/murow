/**
 * WGSL source for the injectable engine helper functions.
 *
 * The backend prepends the source of the helpers a shader calls. The math is
 * ported from the reference WebGPU renderer, so a shader compiled through the
 * facade and one authored in the eager DSL agree exactly.
 */

/** 3D value noise, in the range [0, 1]. */
export const NOISE_WGSL = `fn noise(x: vec3<f32>) -> f32 {
    let px = floor(x.x);
    let py = floor(x.y);
    let pz = floor(x.z);
    let fx = fract(x.x);
    let fy = fract(x.y);
    let fz = fract(x.z);
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sy = fy * fy * (3.0 - 2.0 * fy);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let ax0 = fract(px * 0.1031);
    let ax1 = fract(ax0 + 0.1031);
    let ay0 = fract(py * 0.1031);
    let ay1 = fract(ay0 + 0.1031);
    let az0 = fract(pz * 0.1031);
    let az1 = fract(az0 + 0.1031);
    let d000 = ax0 * (ay0 + 33.33) + ay0 * (az0 + 33.33) + az0 * (ax0 + 33.33);
    let h000 = fract((ax0 + ay0 + 2.0 * d000) * (az0 + d000));
    let d100 = ax1 * (ay0 + 33.33) + ay0 * (az0 + 33.33) + az0 * (ax1 + 33.33);
    let h100 = fract((ax1 + ay0 + 2.0 * d100) * (az0 + d100));
    let d010 = ax0 * (ay1 + 33.33) + ay1 * (az0 + 33.33) + az0 * (ax0 + 33.33);
    let h010 = fract((ax0 + ay1 + 2.0 * d010) * (az0 + d010));
    let d110 = ax1 * (ay1 + 33.33) + ay1 * (az0 + 33.33) + az0 * (ax1 + 33.33);
    let h110 = fract((ax1 + ay1 + 2.0 * d110) * (az0 + d110));
    let d001 = ax0 * (ay0 + 33.33) + ay0 * (az1 + 33.33) + az1 * (ax0 + 33.33);
    let h001 = fract((ax0 + ay0 + 2.0 * d001) * (az1 + d001));
    let d101 = ax1 * (ay0 + 33.33) + ay0 * (az1 + 33.33) + az1 * (ax1 + 33.33);
    let h101 = fract((ax1 + ay0 + 2.0 * d101) * (az1 + d101));
    let d011 = ax0 * (ay1 + 33.33) + ay1 * (az1 + 33.33) + az1 * (ax0 + 33.33);
    let h011 = fract((ax0 + ay1 + 2.0 * d011) * (az1 + d011));
    let d111 = ax1 * (ay1 + 33.33) + ay1 * (az1 + 33.33) + az1 * (ax1 + 33.33);
    let h111 = fract((ax1 + ay1 + 2.0 * d111) * (az1 + d111));
    let x00 = mix(h000, h100, sx);
    let x10 = mix(h010, h110, sx);
    let x01 = mix(h001, h101, sx);
    let x11 = mix(h011, h111, sx);
    let y0 = mix(x00, x10, sy);
    let y1 = mix(x01, x11, sy);
    return mix(y0, y1, sz);
}`;

/** Signed value noise, in the range [-1, 1]. */
export const SNOISE_WGSL = `fn snoise(uv: vec3<f32>, res: f32) -> f32 {
    let s = vec3<f32>(1.0, 100.0, 10000.0);
    let invRes = 1.0 / res;
    let r3 = vec3<f32>(res, res, res);
    let u = uv * res;
    let uv0 = floor(u - floor(u * invRes) * r3) * s;
    let u1 = u + vec3<f32>(1.0, 1.0, 1.0);
    let uv1 = floor(u1 - floor(u1 * invRes) * r3) * s;
    let fr = fract(u);
    let ff = fr * fr * (vec3<f32>(3.0, 3.0, 3.0) - vec3<f32>(2.0, 2.0, 2.0) * fr);
    let v = vec4<f32>(uv0.x + uv0.y + uv0.z, uv1.x + uv0.y + uv0.z, uv0.x + uv1.y + uv0.z, uv1.x + uv1.y + uv0.z);
    let ra = fract(sin(v * 1e-3) * 1e5);
    let r0 = mix(mix(ra.x, ra.y, ff.x), mix(ra.z, ra.w, ff.x), ff.y);
    let dz = uv1.z - uv0.z;
    let v2 = v + vec4<f32>(dz, dz, dz, dz);
    let rb = fract(sin(v2 * 1e-3) * 1e5);
    let r1 = mix(mix(rb.x, rb.y, ff.x), mix(rb.z, rb.w, ff.x), ff.y);
    return mix(r0, r1, ff.z) * 2.0 - 1.0;
}`;

/** Diffuse contribution of one point or spot light. */
export const LIGHT_CONTRIBUTION_WGSL = `fn lightContribution(pos: vec3<f32>, axis: vec3<f32>, color: vec3<f32>, params: vec4<f32>, normal: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
    let intensity = params.x;
    let range = params.y;
    let innerCos = params.z;
    let outerCos = params.w;
    let toLight = vec3<f32>(pos.x - worldPos.x, pos.y - worldPos.y, pos.z - worldPos.z);
    let dist = length(toLight);
    let dir = normalize(toLight);
    let lambert = max(dot(normal, dir), 0.0);
    let atten = clamp(1.0 - dist / max(range, 0.0001), 0.0, 1.0);
    let falloff = atten * atten;
    let axisLen = length(axis);
    let isSpot = axisLen > 0.0001;
    let safeAxis = select(vec3<f32>(0.0, 0.0, 1.0), axis, isSpot);
    let cosAngle = dot(normalize(safeAxis), vec3<f32>(-dir.x, -dir.y, -dir.z));
    let spotCone = smoothstep(outerCos, innerCos, cosAngle);
    let cone = select(1.0, spotCone, isSpot);
    let shadowFactor = 1.0;
    let scale = lambert * falloff * cone * intensity * shadowFactor;
    return vec3<f32>(color.x * scale, color.y * scale, color.z * scale);
}`;

/** Reinhard tone map. */
export const TONEMAP_WGSL = `fn tonemap(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(c.x / (1.0 + c.x), c.y / (1.0 + c.y), c.z / (1.0 + c.z));
}`;

/** Helper source keyed by the call name a shader uses. */
export const HELPER_WGSL: Record<string, string> = {
    noise: NOISE_WGSL,
    snoise: SNOISE_WGSL,
    lightContribution: LIGHT_CONTRIBUTION_WGSL,
    tonemap: TONEMAP_WGSL,
};

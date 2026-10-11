const CAMERA_EFFECT_WGSL = `
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

struct EffectU {
  params: vec4f,
  time: f32,
  resX: f32,
  resY: f32,
  kind: u32,
  near: f32,
  far: f32,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
@group(0) @binding(2) var<uniform> u: EffectU;
@group(0) @binding(3) var histTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var depthSamp: sampler;
@group(0) @binding(6) var bloomTex: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var verts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = verts[i];
  var o: VSOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  var c = textureSample(srcTex, srcSamp, in.uv);
  let lum = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));

  if (u.kind == 0u) {
    // vignette: params = [strength, inner, outer, 0]
    let d = distance(in.uv, vec2f(0.5, 0.5));
    let vig = mix(1.0 - u.params.x, 1.0, smoothstep(u.params.z, u.params.y, d));
    c = vec4f(c.rgb * vig, c.a);
  } else if (u.kind == 1u) {
    // grade: params = [saturation, contrast, brightness, 0]
    var g = mix(vec3f(lum), c.rgb, u.params.x);
    g = (g - 0.5) * u.params.y + 0.5 + u.params.z;
    c = vec4f(g, c.a);
  } else if (u.kind == 2u) {
    c = vec4f(vec3f(lum), c.a);
  } else if (u.kind == 3u) {
    // chromatic aberration: params = [amount, 0, 0, 0]
    let dir = in.uv - vec2f(0.5);
    let amt = u.params.x * 0.02;
    c = vec4f(
      textureSample(srcTex, srcSamp, in.uv + dir * amt).r,
      textureSample(srcTex, srcSamp, in.uv).g,
      textureSample(srcTex, srcSamp, in.uv - dir * amt).b,
      c.a,
    );
  } else if (u.kind == 4u) {
    // scanlines: params = [intensity, frequency, speed, 0]
    let s = sin(in.uv.y * u.params.y * 3.14159 + u.time * u.params.z);
    c = vec4f(c.rgb * (1.0 - u.params.x * 0.5 * s), c.a);
  } else if (u.kind == 5u) {
    // posterize: params = [levels, 0, 0, 0]
    let n = max(u.params.x, 2.0);
    c = vec4f(floor(c.rgb * n) / n, c.a);
  } else if (u.kind == 6u) {
    // motion blur: params = [feedback, 0, 0, 0]
    let h = textureSample(histTex, srcSamp, in.uv);
    c = vec4f(mix(c.rgb, h.rgb, u.params.x), c.a);
  } else if (u.kind == 8u) {
    // fxaa: params = [0,0,0,0]
    let luma = vec3f(0.299, 0.587, 0.114);
    let texel = vec2f(1.0 / u.resX, 1.0 / u.resY);
    let nw = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(-1.0, -1.0) * texel).rgb, luma);
    let ne = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(1.0, -1.0) * texel).rgb, luma);
    let sw = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(-1.0, 1.0) * texel).rgb, luma);
    let se = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(1.0, 1.0) * texel).rgb, luma);
    let mN = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(0.0, -1.0) * texel).rgb, luma);
    let mS = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(0.0, 1.0) * texel).rgb, luma);
    let mW = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(-1.0, 0.0) * texel).rgb, luma);
    let mE = dot(textureSample(srcTex, srcSamp, in.uv + vec2f(1.0, 0.0) * texel).rgb, luma);
    let lumaMin = min(lum, min(min(nw, ne), min(min(sw, se), min(min(mN, mS), min(mW, mE)))));
    let lumaMax = max(lum, max(max(nw, ne), max(max(sw, se), max(max(mN, mS), max(mW, mE)))));
    let dir = vec2f(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
    let reduce = max((nw + ne + sw + se) * 0.0078125, 0.0078125);
    let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    let step = clamp(dir * rcp, vec2f(-8.0, -8.0), vec2f(8.0, 8.0)) * texel;
    let a = 0.5 * (textureSample(srcTex, srcSamp, in.uv + step * (1.0 / 3.0 - 0.5)).rgb
                 + textureSample(srcTex, srcSamp, in.uv + step * (2.0 / 3.0 - 0.5)).rgb);
    let b = a * 0.5 + 0.25 * (textureSample(srcTex, srcSamp, in.uv + step * -0.5).rgb
                            + textureSample(srcTex, srcSamp, in.uv + step * 0.5).rgb);
    let lumaB = dot(b, luma);
    let useB = lumaB < lumaMin || lumaB > lumaMax;
    c = vec4f(select(a, b, useB), c.a);
  } else if (u.kind == 9u) {
    // depth fog: params = [colorR, colorG, colorB, density]
    let raw = textureSample(depthTex, depthSamp, in.uv);
    let ndc = raw * 2.0 - 1.0;
    let lin = (2.0 * u.near * u.far) / (u.far + u.near - ndc * (u.far - u.near));
    let f = 1.0 - exp(-lin * u.params.w);
    c = vec4f(mix(c.rgb, u.params.rgb, f), c.a);
  } else if (u.kind == 10u) {
    // bloom brightpass: params = [threshold, 0, 0, 0]
    let b = max(c.rgb - u.params.x, vec3f(0.0, 0.0, 0.0));
    c = vec4f(b, 1.0);
  } else if (u.kind == 11u) {
    // separable blur: params = [offsetX, offsetY, 0, 0]
    let o = vec2f(u.params.x, u.params.y);
    c = textureSample(srcTex, srcSamp, in.uv) * 0.227027;
    c += textureSample(srcTex, srcSamp, in.uv + o * 1.3846153846) * 0.3162162162;
    c += textureSample(srcTex, srcSamp, in.uv - o * 1.3846153846) * 0.3162162162;
    c += textureSample(srcTex, srcSamp, in.uv + o * 3.2307692308) * 0.0702702703;
    c += textureSample(srcTex, srcSamp, in.uv - o * 3.2307692308) * 0.0702702703;
  } else if (u.kind == 12u) {
    // bloom composite: params = [intensity, 0, 0, 0]
    let bloom = textureSample(bloomTex, srcSamp, in.uv);
    c = vec4f(c.rgb + bloom.rgb * u.params.x, c.a);
  }
  // kind 7 = copy (identity), used to present the final off-screen result.

  return c;
}
`;

const HITBOX_WGSL = `
struct Uniforms {
    mvp: mat4x4<f32>,
    color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
    return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
    return u.color;
}
`;

const SPRITE_2D_WGSL = `
// --- Uniforms ---
struct Uniforms {
    viewProjection: mat3x3<f32>,
    alpha: f32,
    resolution: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// --- Instance data (storage buffers) ---
struct DynamicInstance {
    prevX: f32,
    prevY: f32,
    currX: f32,
    currY: f32,
    prevRotation: f32,
    currRotation: f32,
}

struct StaticInstance {
    scaleX: f32,
    scaleY: f32,
    uvMinX: f32,
    uvMinY: f32,
    uvMaxX: f32,
    uvMaxY: f32,
    layer: f32,
    flipX: f32,
    flipY: f32,
    opacity: f32,
    tintR: f32,
    tintG: f32,
    tintB: f32,
    tintA: f32,
}

@group(0) @binding(1) var<storage, read> dynamicInstances: array<DynamicInstance>;
@group(0) @binding(2) var<storage, read> staticInstances: array<StaticInstance>;

// --- Texture ---
@group(1) @binding(0) var spriteTex: texture_2d<f32>;
@group(1) @binding(1) var spriteSampler: sampler;

// --- Vertex output ---
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) tint: vec4<f32>,
    @location(2) opacity: f32,
}

@vertex
fn vs_main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
    let dyn = dynamicInstances[instanceIndex];
    let stat = staticInstances[instanceIndex];

    // Interpolate position
    let alpha = uniforms.alpha;
    let x = mix(dyn.prevX, dyn.currX, alpha);
    let y = mix(dyn.prevY, dyn.currY, alpha);

    // Interpolate rotation
    let rotation = mix(dyn.prevRotation, dyn.currRotation, alpha);

    // Quad vertices: 6 verts for 2 triangles
    let isRight = f32((vertexIndex & 1u) ^ ((vertexIndex >> 1u) & 1u));
    let isTop = f32((vertexIndex + 1u) / 3u);
    // Adjust for second triangle
    let localX = select(-0.5, 0.5, isRight > 0.0) * stat.scaleX;
    let localY = select(-0.5, 0.5, isTop > 0.0) * stat.scaleY;

    // Apply flip
    let fx = select(1.0, -1.0, stat.flipX > 0.0);
    let fy = select(1.0, -1.0, stat.flipY > 0.0);
    let flippedX = localX * fx;
    let flippedY = localY * fy;

    // Rotate
    let cosR = cos(rotation);
    let sinR = sin(rotation);
    let rotX = flippedX * cosR - flippedY * sinR;
    let rotY = flippedX * sinR + flippedY * cosR;

    // World position
    let worldPos = vec3<f32>(x + rotX, y + rotY, 1.0);

    // Apply camera view-projection
    let clipPos = uniforms.viewProjection * worldPos;

    // UV mapping
    let u = mix(stat.uvMinX, stat.uvMaxX, isRight);
    let v = mix(stat.uvMinY, stat.uvMaxY, 1.0 - isTop);

    var out: VertexOutput;
    out.position = vec4<f32>(clipPos.xy, 0.0, 1.0);
    out.uv = vec2<f32>(u, v);
    out.tint = vec4<f32>(stat.tintR, stat.tintG, stat.tintB, stat.tintA);
    out.opacity = stat.opacity;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(spriteTex, spriteSampler, in.uv);
    let tinted = texColor * in.tint;
    return vec4<f32>(tinted.rgb, tinted.a * in.opacity);
}
`;

/** 3D value noise, in the range [0, 1]. */
const NOISE_WGSL = `
fn noise(x: vec3<f32>) -> f32 {
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
const SNOISE_WGSL = `
fn snoise(uv: vec3<f32>, res: f32) -> f32 {
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
const LIGHT_CONTRIBUTION_WGSL = `
fn lightContribution(pos: vec3<f32>, axis: vec3<f32>, color: vec3<f32>, params: vec4<f32>, normal: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
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
const TONEMAP_WGSL = `
fn tonemap(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(c.x / (1.0 + c.x), c.y / (1.0 + c.y), c.z / (1.0 + c.z));
}`;

/** Every WGSL source the WebGPU backend uses, by name. */
export const WGSL = {
    cameraEffect: CAMERA_EFFECT_WGSL,
    hitbox: HITBOX_WGSL,
    sprite2d: SPRITE_2D_WGSL,
    noise: NOISE_WGSL,
    snoise: SNOISE_WGSL,
    lightContribution: LIGHT_CONTRIBUTION_WGSL,
    tonemap: TONEMAP_WGSL,
};

/** Helper source keyed by the call name a shader uses. */
export const HELPER_WGSL: Record<string, string> = {
    noise: WGSL.noise,
    snoise: WGSL.snoise,
    lightContribution: WGSL.lightContribution,
    tonemap: WGSL.tonemap,
};

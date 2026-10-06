import { d } from '../../../shaders/typegpu';

/** Shared uniforms for custom camera effects: time + drawable resolution. */
export const EFFECT_SCENE_UNIFORMS = d.struct({
    time: d.f32,
    resX: d.f32,
    resY: d.f32,
    _pad: d.f32,
});

/**
 * Fullscreen shader shared by every camera effect. The active effect is selected
 * by `u.kind` and parameterised by `u.params`; `CameraEffectStack` runs one pass
 * per entry in `camera.effects`, ping-ponging through two off-screen targets.
 *
 * Written as raw WGSL (fullscreen triangle, no vertex buffer) so it stays
 * independent of the declarative material pipeline.
 */
export const CAMERA_EFFECT_WGSL = `
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
  }
  // kind 7 = copy (identity), used to present the final off-screen result.

  return c;
}
`;

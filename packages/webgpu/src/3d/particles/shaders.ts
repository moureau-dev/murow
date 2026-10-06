/** f32 fields per particle record (must match `Particle3D` in the system). */
export const PARTICLE_3D_STRIDE = 20;
/** f32 fields in the render frame uniform. */
export const PARTICLE_3D_FRAME_FLOATS = 32;

/**
 * Instanced, camera-facing 3D particle shader. One quad (6 vertices) per live
 * particle; dead particles and particles belonging to another material emit a
 * degenerate vertex, so a material draws by binding its own texture + id.
 * Raw WGSL so it stays independent of the material pipeline.
 *
 * Bind group 0:
 *   0 frame uniform, 1 particle storage, 2 texture, 3 sampler, 4 material uniform
 * Material uniform: [matId, useTexture, atlasCols, atlasRows].
 */
export const PARTICLE_3D_WGSL = `
struct Particle {
  px: f32, py: f32, pz: f32,
  vx: f32, vy: f32, vz: f32,
  age: f32, life: f32, size: f32,
  r: f32, g: f32, b: f32, a: f32,
  gx: f32, gy: f32, gz: f32,
  mat: f32,
  grow: f32,
  rot: f32,
  spin: f32,
};

struct Frame {
  viewProj: mat4x4f,
  right: vec4f,
  up: vec4f,
  params: vec4f,
  counts: vec4f,
};

struct MaterialU {
  matId: f32,
  useTexture: f32,
  atlasCols: f32,
  atlasRows: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> material: MaterialU;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  var o: VSOut;
  let p = particles[ii];
  if (p.life <= 0.0 || p.mat != material.matId) {
    o.pos = vec4f(0.0, 0.0, 0.0, 0.0);
    o.uv = vec2f(0.0, 0.0);
    o.color = vec4f(0.0, 0.0, 0.0, 0.0);
    return o;
  }
  let frac = p.age / p.life;
  let size = p.size * mix(1.0, p.grow, frac) * frame.params.w;
  let ang = p.rot + p.spin * p.age;
  let cs = cos(ang);
  let sn = sin(ang);
  let c0 = corners[vi];
  let c = vec2f(c0.x * cs - c0.y * sn, c0.x * sn + c0.y * cs);
  let world = vec3f(p.px, p.py, p.pz) + frame.right.xyz * (c.x * size) + frame.up.xyz * (c.y * size);
  o.pos = frame.viewProj * vec4f(world, 1.0);
  o.uv = c * 0.5 + vec2f(0.5, 0.5);
  o.color = vec4f(p.r, p.g, p.b, p.a * (1.0 - frac));
  return o;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  var base: vec4f;
  if (material.useTexture > 0.5) {
    base = textureSample(tex, samp, in.uv);
  } else {
    let d = length(in.uv * 2.0 - vec2f(1.0, 1.0));
    base = vec4f(1.0, 1.0, 1.0, smoothstep(1.0, 0.15, d));
  }
  let a = base.a * in.color.a;
  return vec4f(in.color.rgb * base.rgb * a, a);
}
`;

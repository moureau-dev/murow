/**
 * Default 2D sprite shader — WGSL source as a template string.
 *
 * Supports:
 * - Instanced rendering (one draw call per spritesheet batch)
 * - GPU-side interpolation between previous and current frame
 * - Per-sprite: position, rotation, scale, UV, tint, opacity, flip
 * - Camera transform via uniform matrix
 */

export const SPRITE_2D_WGSL = /* wgsl */ `
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

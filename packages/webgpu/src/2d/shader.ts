/**
 * TypeGPU TGSL sprite shader.
 *
 * Generates quad vertices procedurally from vertexIndex (no vertex buffer).
 * Instance data comes from storage buffers via bind group layout.
 *
 * NOTE: TGSL bodies must use `function` syntax, not arrow functions.
 */
import tgpu from 'typegpu';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';
import { DynamicSprite, StaticSprite, SpriteUniforms } from '../core/types';

// --- Bind group layouts ---

export function createSpriteLayout(maxSprites: number) {
    return tgpu.bindGroupLayout({
        uniforms: { uniform: SpriteUniforms },
        dynamicInstances: { storage: d.arrayOf(DynamicSprite, maxSprites) },
        staticInstances: { storage: d.arrayOf(StaticSprite, maxSprites) },
        slotIndices: { storage: d.arrayOf(d.u32, maxSprites) },
    });
}

export function createTextureLayout() {
    return tgpu.bindGroupLayout({
        spriteTex: { texture: d.texture2d() },
        spriteSampler: { sampler: 'filtering' as const },
    });
}

export type SpriteDataLayout = ReturnType<typeof createSpriteLayout>;
export type SpriteTextureLayout = ReturnType<typeof createTextureLayout>;

// --- Shaders ---

export function createSpriteVertex(
    spriteLayout: SpriteDataLayout,
    _textureLayout: SpriteTextureLayout,
) {
    return tgpu.vertexFn({
        in: {
            vertexIndex: d.builtin.vertexIndex,
            instanceIndex: d.builtin.instanceIndex,
        },
        out: {
            pos: d.builtin.position,
            vUv: d.vec2f,
            vTint: d.vec4f,
            vOpacity: d.f32,
        },
    })(function(input) {
        const vertexIndex = input.vertexIndex;
        const instanceIndex = input.instanceIndex;

        // Indirection: instanceIndex → real slot in the data buffers
        const slot = spriteLayout.$.slotIndices[instanceIndex];
        const dyn = spriteLayout.$.dynamicInstances[slot];
        const stat = spriteLayout.$.staticInstances[slot];
        const alpha = spriteLayout.$.uniforms.alpha;

        // Interpolate position
        const x = std.mix(dyn.prevX, dyn.currX, alpha);
        const y = std.mix(dyn.prevY, dyn.currY, alpha);

        // Interpolate rotation
        const rotation = std.mix(dyn.prevRotation, dyn.currRotation, alpha);

        // Generate quad from vertexIndex (6 vertices, 2 triangles)
        // Vertices: 0=BL, 1=BR, 2=TR, 3=BL, 4=TR, 5=TL
        // Use step() to produce f32 0.0/1.0 instead of select() which returns i32
        const vi = std.add(std.mul(vertexIndex, 1.0), 0.0); // cast to f32

        // isRight: vertices 1, 4, 5 → use step tricks
        // isTop: vertices 2, 3, 5
        // Simpler: use a lookup via step/abs math
        // For a 6-vertex quad, encode corners as a float lookup
        // v0(-0.5,-0.5) v1(0.5,-0.5) v2(0.5,0.5) v3(-0.5,-0.5) v4(0.5,0.5) v5(-0.5,0.5)
        // x: [-0.5, 0.5, 0.5, -0.5, 0.5, -0.5]
        // y: [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5]
        // rightF: [0, 1, 1, 0, 1, 0]
        // topF:   [0, 0, 1, 0, 1, 1]

        // Bit trick: for indices 0-5, isRight = (index==1)||(index==2)||(index==4)
        // Using step: rightF = step(0.5, index) * step(index, 2.5) + step(3.5, index) * step(index, 4.5)
        // Simpler approach: just use vertexIndex % 3 and vertexIndex / 3 patterns

        // Triangle 0 (indices 0,1,2): BL, BR, TR
        // Triangle 1 (indices 3,4,5): BL, TR, TL
        // For each triangle, local index = vertexIndex % 3
        // tri0: localIdx 0=BL, 1=BR, 2=TR
        // tri1: localIdx 0=BL, 1=TR, 2=TL

        // rightF for tri0: step(0.5, localIdx) → 1 for idx 1,2
        // rightF for tri1: step(0.5, localIdx) * step(localIdx, 1.5) → 1 for idx 1 only
        // topF for tri0: step(1.5, localIdx) → 1 for idx 2 only
        // topF for tri1: step(0.5, localIdx) → 1 for idx 1,2

        // Actually this is getting complex. Let me use the simplest f32-safe approach:
        // Precompute x,y,u,v per vertex using step chains

        // rightF: 1.0 for vertices 1,2,4
        const r1 = std.step(0.5, vi) * std.step(vi, 1.5);
        const r2 = std.step(1.5, vi) * std.step(vi, 2.5);
        const r4 = std.step(3.5, vi) * std.step(vi, 4.5);
        const rightF = std.clamp(std.add(std.add(r1, r2), r4), 0.0, 1.0);

        // topF: 1.0 for vertices 2,3,5  wait no — for our quad:
        // v0=BL v1=BR v2=TR v3=BL v4=TR v5=TL
        // topF: [0, 0, 1, 0, 1, 1] → vertices 2,4,5
        const t2 = std.step(1.5, vi) * std.step(vi, 2.5);
        const t4 = std.step(3.5, vi) * std.step(vi, 4.5);
        const t5 = std.step(4.5, vi) * std.step(vi, 5.5);
        const topF = std.clamp(std.add(std.add(t2, t4), t5), 0.0, 1.0);

        const quadX = std.sub(rightF, 0.5);
        const quadY = std.sub(topF, 0.5);

        // Scale
        const scaledX = std.mul(quadX, stat.scaleX);
        const scaledY = std.mul(quadY, stat.scaleY);

        // Flip: step + math to stay in f32
        const flipXGt = std.step(0.5, stat.flipX);
        const fxMul = std.sub(1.0, std.mul(2.0, flipXGt));
        const flipYGt = std.step(0.5, stat.flipY);
        const fyMul = std.sub(1.0, std.mul(2.0, flipYGt));
        const flippedX = std.mul(scaledX, fxMul);
        const flippedY = std.mul(scaledY, fyMul);

        // Rotate
        const cosR = std.cos(rotation);
        const sinR = std.sin(rotation);
        const rotX = std.sub(std.mul(flippedX, cosR), std.mul(flippedY, sinR));
        const rotY = std.add(std.mul(flippedX, sinR), std.mul(flippedY, cosR));

        // World position -> clip via camera matrix
        const worldPos = d.vec3f(std.add(x, rotX), std.add(y, rotY), 1.0);
        const clipPos = std.mul(spriteLayout.$.uniforms.viewProjection, worldPos);

        // UV
        const u = std.mix(stat.uvMinX, stat.uvMaxX, rightF);
        const v = std.mix(stat.uvMinY, stat.uvMaxY, std.sub(1.0, topF));

        return {
            pos: d.vec4f(clipPos.x, clipPos.y, 0, 1),
            vUv: d.vec2f(u, v),
            vTint: d.vec4f(stat.tintR, stat.tintG, stat.tintB, stat.tintA),
            vOpacity: stat.opacity,
        };
    });
}

export function createSpriteFragment(
    _spriteLayout: SpriteDataLayout,
    textureLayout: SpriteTextureLayout,
) {
    return tgpu.fragmentFn({
        in: {
            vUv: d.vec2f,
            vTint: d.vec4f,
            vOpacity: d.f32,
        },
        out: d.vec4f,
    })(function(input) {
        const texColor = std.textureSample(
            textureLayout.$.spriteTex,
            textureLayout.$.spriteSampler,
            input.vUv,
        );
        const tinted = std.mul(texColor, input.vTint);
        return d.vec4f(tinted.x, tinted.y, tinted.z, std.mul(tinted.w, input.vOpacity));
    });
}

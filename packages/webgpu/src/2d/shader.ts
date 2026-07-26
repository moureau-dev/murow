/**
 * TypeGPU TGSL sprite shader.
 *
 * Generates quad vertices procedurally from vertexIndex (no vertex buffer).
 * Instance data comes from storage buffers via bind group layout.
 *
 * NOTE: TGSL bodies must use `function` syntax, not arrow functions.
 */
import { tgpu, d, std } from '../shaders/typegpu';
import { DynamicSprite, StaticSprite, SpriteUniforms } from '../core/types';
import { attachShaderMetadata } from '../shaders/runtime-transpile';

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
    const fn = function(input: any) {
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
        const vi = d.f32(vertexIndex); // explicit u32 → f32

        // rightF: 1.0 for vertices 1,2,4
        const r1 = std.step(0.5, vi) * std.step(vi, 1.5);
        const r2 = std.step(1.5, vi) * std.step(vi, 2.5);
        const r4 = std.step(3.5, vi) * std.step(vi, 4.5);
        const rightF = std.clamp(std.add(std.add(r1, r2), r4), 0.0, 1.0);

        // topF: 1.0 for vertices 2,4,5
        const t2 = std.step(1.5, vi) * std.step(vi, 2.5);
        const t4 = std.step(3.5, vi) * std.step(vi, 4.5);
        const t5 = std.step(4.5, vi) * std.step(vi, 5.5);
        const topF = std.clamp(std.add(std.add(t2, t4), t5), 0.0, 1.0);

        const quadX = std.sub(rightF, 0.5);
        const quadY = std.sub(topF, 0.5);

        // Scale
        const scaledX = std.mul(quadX, stat.scaleX);
        const scaledY = std.mul(quadY, stat.scaleY);

        // Flip
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
    };
    attachShaderMetadata(fn, () => ({ d, std, spriteLayout }), true, { d, std });
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
    })(fn);
}

export function createSpriteFragment(
    _spriteLayout: SpriteDataLayout,
    textureLayout: SpriteTextureLayout,
) {
    const fn = function(input: any) {
        const texColor = std.textureSample(
            textureLayout.$.spriteTex,
            textureLayout.$.spriteSampler,
            input.vUv,
        );
        const tinted = std.mul(texColor, input.vTint);
        return d.vec4f(tinted.x, tinted.y, tinted.z, std.mul(tinted.w, input.vOpacity));
    };
    attachShaderMetadata(fn, () => ({ d, std, textureLayout }), true, { d, std });
    return tgpu.fragmentFn({
        in: {
            vUv: d.vec2f,
            vTint: d.vec4f,
            vOpacity: d.f32,
        },
        out: d.vec4f,
    })(fn);
}

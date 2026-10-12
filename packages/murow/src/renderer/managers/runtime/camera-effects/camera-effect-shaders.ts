import { d } from '../gpu-ns';


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

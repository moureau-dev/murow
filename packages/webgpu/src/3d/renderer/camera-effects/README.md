# Camera effects

Fullscreen post passes applied after the scene, driven by `renderer.camera.effects` (a `CameraEffectList`).

- `stack.ts` — `CameraEffectStack`: owns the two off-screen scene-sized targets, the shared fullscreen pipeline, per-effect dynamic uniform slots, ping-pong application, and the final present. Custom (`shader`) effects are compiled declaratively at first use.
- `shaders.ts` — `CAMERA_EFFECT_WGSL`, the built-in effect library (selected by `u.kind`), plus `EFFECT_SCENE_UNIFORMS`.

Built-ins: `vignette`, `grade`, `grayscale`, `chromatic`, `scanlines`, `posterize`, `motionBlur` (temporal), `fxaa` (anti-aliasing), `fog` (exponential depth fog).

The built-in library also binds the scene **depth** texture (bindings 4/5) plus camera `near`/`far`, wired via `CameraEffectStack.setDepth(...)` on init/resize. Depth is only available to the raw-WGSL built-ins (TypeGPU's custom-effect path can't bind `texture_depth_2d`). Custom effects receive `input.vUV`, `textures.src`/`textures.sampler`, `material.<name>`, `scene.time`/`scene.resolutionX/Y`, and `history`.

Constructed by `WebGPU3DRenderer` with `{ root, format, maxEffects }`.

# Camera effects

Fullscreen post passes applied after the scene, driven by `renderer.camera.effects` (a `CameraEffectList`).

- `stack.ts` — `CameraEffectStack`: owns the two off-screen scene-sized targets, the shared fullscreen pipeline, per-effect dynamic uniform slots, ping-pong application, and the final present. Custom (`shader`) effects are compiled declaratively at first use.
- `shaders.ts` — `CAMERA_EFFECT_WGSL`, the built-in effect library (selected by `u.kind`), plus `EFFECT_SCENE_UNIFORMS`.

Built-ins: `vignette`, `grade`, `grayscale`, `chromatic`, `scanlines`, `posterize`, `motionBlur` (temporal). Custom effects receive `input.vUV`, `textures.src`/`textures.sampler`, `material.<name>`, `scene.time`/`scene.resolutionX/Y`, and `history`.

Constructed by `WebGPU3DRenderer` with `{ root, format, maxEffects }`.

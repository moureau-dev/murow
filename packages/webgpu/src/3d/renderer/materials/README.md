# Materials

`renderer.createMaterial(spec)` compiles a `MaterialSpec` into a `MaterialHandle` backed by a dense `SlotMap` slot (the only material identity — there is no string registry).

- `specs.ts` — `MaterialSpec`, render state (`blend`, `blendState`, `depthWrite`, `depthTest`, `cull`, `colorWrite`, `depthBias`) and `resolveRenderState`.
- `built-in.ts` — engine shaders (`standard` / `unlit` / `emissive`), the shared `EngineMaterialUniforms` layout (color, opacity, emissive, `alphaTest`, UV transform), and the helper functions `noise` / `snoise`.
- `material-library.ts` — `MaterialLibrary`: slot allocation, per-material uniform buffers, per-material samplers, bind groups, and the declarative `shader` compile path (named textures, custom uniforms, optional custom vertex).

Notes:

- Batched by `(materialId, modelId)`; opaque draws first, then transparent.
- `standard` is Lambert + two-sided; no PBR/normal maps yet.
- Textures are mipmapped on upload; atlas sprites should sample LOD 0.

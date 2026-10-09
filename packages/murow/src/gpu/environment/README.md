# gpu/environment

The built-in shader environment: the struct schemas and bind group layout the
engine's shaders rely on. Target helper source (noise, tone map) lives in the
backend, not here.

- `structs.ts` - `GpuStruct` instances for `MeshUniforms`,
  `EngineMaterialUniforms`, `Light`, `DynamicMesh`, `StaticMesh`, and
  `SkinnedStaticMesh`. Field names, order, and types match the renderer's flat
  upload buffers.
- `bindings.ts` - `StandardBindings` records the scene, light, material, and
  texture binding slots, with `defaultBindings` as the engine default.

The DSL externals in `gpu/dsl/externals.ts` turn these schemas and slots into
IR-producing objects.

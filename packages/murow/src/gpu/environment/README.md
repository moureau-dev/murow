# gpu/environment

The built-in shader environment: the struct schemas, bind group layout, and
injectable WGSL helpers the engine's shaders rely on.

- `structs.ts` - `GpuStruct` instances for `MeshUniforms`,
  `EngineMaterialUniforms`, `Light`, `DynamicMesh`, `StaticMesh`, and
  `SkinnedStaticMesh`. Field names, order, and types match the renderer's flat
  upload buffers.
- `bindings.ts` - `StandardBindings` records the scene, light, material, and
  texture binding slots, with `defaultBindings` as the engine default.
- `helpers.ts` - WGSL source strings for `noise`, `snoise`, `lightContribution`,
  and `tonemap`, injected by the backend when a shader calls them.

The DSL externals in `gpu/dsl/externals.ts` turn these schemas and slots into
IR-producing objects.

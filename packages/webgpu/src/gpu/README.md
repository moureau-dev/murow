# webgpu/gpu

WebGPU's implementation of the `murow/gpu` target seam.

`murow/gpu` is target-agnostic: it owns the shader IR, the emit walker, the data
schemas, and the resource descriptors, but no language strings. This module
supplies the WGSL side:

- `wgsl-syntax.ts` - `WgslSyntax` implements every `TargetSyntax` hook with WGSL
  (`typeName`, `builtin`, `paramDecl`, `returnType`, `entrySignature`,
  `declareBinding`, `declareLet`, `construct`, `cast`, `sample`, `literal`,
  `formatScalar`, `structDecl`, `loop`, `discard`/`break`/`continue`,
  `addressSpace`, `preamblePrefix`).
- `wgsl-backend.ts` - `WgslBackend` is `BaseBackend` with `WgslSyntax` and all
  WebGPU capabilities enabled.

The renderer (and any other WebGPU code) uses `WgslBackend` to compile
`murow/gpu` IR to WGSL. A WebGL backend, when built, supplies a sibling
`GlslSyntax` in its own package; nothing target-specific lives in `murow/gpu`.

## Facade

`tgpu.ts` mirrors the typegpu surface the renderer uses. A marked entry
(`tgpu.vertexFn`/`fragmentFn`/`computeFn`/`fn`) carries its stage, input schema,
output schema, and named externals. On `resolveWithContext`, the facade lowers
the function body from source through `murow/gpu/compiler`'s parser, then emits
WGSL with `WgslBackend`:

- `d.location(i, type)` and `d.builtin.*` markers become `@location` parameters
  and stage builtins.
- A vertex `out` schema becomes the `vs_out` struct and the entry's outputs.
- Named externals (`data.ts` layouts via `environment.ts`'s `handleView`, plus
  `std.ts`) resolve inside the body.
- `helpers.ts` holds the injectable engine helper WGSL (noise, snoise,
  lightContribution, tonemap); the backend prepends each helper only when the
  entry calls it.

The renderer is not yet wired to the facade; `shaders/typegpu.ts` still
delegates to typegpu. See the TODO there.


# webgpu/gpu

WebGPU's implementation of the `murow/gpu` target seam.

`murow/gpu` is target-agnostic: it owns the shader IR, the emit walker, the data
schemas, the resource descriptors, and the class-based backend, context, and
resource API. This module supplies the WGSL and WebGPU side.

## Layout

- `syntax.ts` - `WgslSyntax` implements every `TargetSyntax` hook with WGSL
  (`typeName`, `builtin`, `paramDecl`, `returnType`, `entrySignature`,
  `declareBinding`, `declareLet`, `construct`, `cast`, `sample`, `literal`,
  `formatScalar`, `structDecl`, `loop`, `discard`/`break`/`continue`,
  `addressSpace`, `preamblePrefix`).
- `helpers.ts` - injectable engine helper source (noise, snoise,
  `lightContribution`, `tonemap`). The backend prepends each helper only when an
  entry calls it.
- `backend/` - `wgslSpec` (a `GpuBackendSpec` ready for `new GpuBackend`),
  `wgslIntrinsics` (WGSL-only intrinsics: `saturate` to `clamp`, atomics take a
  pointer), and `WgslBackend` (`BaseBackend` with `WgslSyntax`).
- `device.ts` - `webGpuDevice` (a `GpuDevice` over a raw `GPUDevice`),
  `createWebGpuContext` (a `GpuContext` for WebGPU), and
  `createGpuBindGroupLayout`.

Compile a program with `new GpuBackend(wgslSpec).compile(program)`; build a
context with `await createWebGpuContext()`.

## Facade (being removed)

`tgpu.ts`, `root.ts`, and `environment.ts` are the transitional typegpu-style
facade the renderer still uses. They are removed as the renderer moves onto
`GpuShader`/`GpuProgram`/`GpuContext` (the compute path already has). `d` and
`std` come from `murow/gpu/dsl`.

# webgpu/gpu

WebGPU's implementation of the `murow/gpu` target seam. Small on purpose: a
backend is a target syntax plus a device factory, and everything else lives in
`murow/gpu`.

## Layout

- `syntax.ts` - `WgslSyntax`, the `TargetSyntax` for WGSL: type names, builtins,
  parameter and binding declarations, entry signatures, casts, sampling,
  literals, struct declarations, loops, and the preamble prefix.
- Injecting helper source (noise, snoise, `shadeLight`, `tonemap`) — the
  WGSL lives in `../shaders.ts` (`HELPER_WGSL`); the backend prepends a helper
  only when an entry calls it.
- `backend/` - `wgslSpec` (a `GpuBackendSpec` for WGSL), `wgslIntrinsics`
  (WGSL-only intrinsics: `saturate` to `clamp`, atomics take a pointer),
  `compileProgram`, and the `WgslBackend` `BaseBackend`.
- `device.ts` - `webGpuDevice` (a `GpuDevice` over a raw `GPUDevice`),
  `createWebGpuContext` (a `GpuContext`), `createGpuBindGroupLayout`, and
  `createRawBuffer`.

## Building a backend

Compile with `compileProgram(shaders)` (or `new GpuBackend(wgslSpec).compile`).
Build a context with `await createWebGpuContext()`. A different target (WebGL) is
the same shape: a `TargetSyntax`, a spec object, and a device factory.

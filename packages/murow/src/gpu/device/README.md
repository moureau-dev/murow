# device

Backend-neutral device contracts.

- `render-api.ts` - the `Raw*` types (`RawDevice`, `RawBuffer`, `RawTexture`,
  `RawBindGroupLayout`, `RawCommandEncoder`, ...). The shared renderer in
  `murow/renderer/managers/runtime` is written against these and receives a
  concrete device through its injected runtime.
- `gpu-device.ts` - `GpuDevice`: buffers, textures, bind groups, pipelines,
  draw, and dispatch behind integer handles. `GpuContext` and the typed
  resources allocate through it.
- `recording-device.ts` - `RecordingDevice`, an in-memory `GpuDevice` that
  records every call, for tests.

Compute and storage-buffer methods are WebGPU capabilities.

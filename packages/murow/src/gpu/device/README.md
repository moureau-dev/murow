# device

The abstract GPU device. Each backend implements it; the shared renderer base
talks only to this interface, which keeps renderer logic testable against a mock.

- `gpu-device.ts` - `GpuDevice`: buffers, textures, bind groups, pipelines,
  draw, dispatch.

Compute and storage-buffer methods are WebGPU-only capabilities.

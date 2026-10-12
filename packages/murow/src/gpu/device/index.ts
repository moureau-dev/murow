/**
 * The abstract GPU device.
 *
 * `GpuDevice` is the backend-agnostic contract for buffers, textures, bind
 * groups, pipelines, draw, and dispatch. `RecordingDevice` is an in-memory
 * implementation for tests.
 */

export * from './gpu-device';
export * from './recording-device';
export * from './render-api';

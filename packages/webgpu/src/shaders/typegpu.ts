/**
 * Renderer shader namespace shim.
 *
 * Re-exports the `murow/gpu` facade as the `tgpu`, `d`, and `std` the engine
 * shaders import. The facade lowers shader bodies with `murow/gpu` and emits
 * WGSL through the WebGPU backend, so no TypeGPU code runs at runtime.
 *
 * `d` and `std` are typed loosely here so the terse shader bodies written
 * against TypeGPU's operator-overloading value type keep compiling.
 */
import { d as facadeD, std as facadeStd, tgpu as facadeTgpu } from '../gpu';

export const d: any = facadeD;
export const std: any = facadeStd;
export const tgpu = facadeTgpu;

/** Type-only alias for matrix-valued shader locals. */
export type Mat4x4f = any;

/** Type-only members used in shader function signatures. */
export namespace d {
    export type f32 = any;
    export type i32 = any;
    export type u32 = any;
    export type bool = any;
    export type v2f = any;
    export type v3f = any;
    export type v4f = any;
    export type m3x3f = any;
    export type m4x4f = any;
}

export type {
    TgpuRoot,
    TgpuBuffer,
    TgpuBindGroupLayout,
    TgpuVertexFn,
    TgpuFragmentFn,
    TgpuComputeFn,
    TgpuRenderPipeline,
    TgpuBindGroup,
    TgpuComputePipeline,
    AnyWgslData,
    AnyData,
    Infer,
} from '../gpu';

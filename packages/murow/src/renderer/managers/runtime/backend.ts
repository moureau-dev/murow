/**
 * Renderer runtime ports (dependency-injected).
 *
 * The renderer never imports a concrete GPU API. It receives a
 * {@link RendererRuntime} — built by the platform package (`murow/webgpu`) or
 * by a user — and calls it. No globals, no import side effects.
 */
import type {
    RawBindGroupLayout,
    RawBuffer,
    RawCanvasContext,
    RawDevice,
    RawTextureFormat,
    RawTextureView,
} from 'murow/gpu';

/** Compute is backend-specific; a backend supplies an implementation. */
export interface ComputeProvider {
    ComputeBuilder: new (...args: any[]) => any;
    ComputeManager: new (...args: any[]) => any;
    buildAnimationKernel(...args: any[]): any;
    uploadPackedToKernel(...args: any[]): any;
    packAnimationData(...args: any[]): any;
}

/** The present target a renderer draws to. Backend-specific (canvas/surface). */
export interface Presentation {
    readonly device: RawDevice;
    readonly format: RawTextureFormat;
    readonly context: RawCanvasContext;
    configure(descriptor: { alphaMode?: string }): void;
    getCurrentTexture(): { createView(): RawTextureView };
}

/** Everything the renderer needs from a backend, injected via the constructor. */
export interface RendererRuntime {
    /** Create the present target (device + surface) for a canvas. */
    createPresentation(canvas: HTMLCanvasElement): Promise<Presentation>;
    /** The active present target, set once {@link createPresentation} resolves. */
    presentation: Presentation;
    /** Compile linked shaders to target source. */
    compile(shaders: readonly unknown[]): { code: string };
    /** Allocate a raw buffer from a schema and usage. */
    createRawBuffer(schema: unknown, usage?: unknown): RawBuffer;
    /** Build a bind group layout from a descriptor. */
    createBindGroupLayout(descriptor: unknown): RawBindGroupLayout;
    /** Named shader helper source (WGSL/GLSL/…). */
    shaderSource(name: string): string;
    /** Backend-specific compute implementation. */
    readonly compute: ComputeProvider;
}

export { sizeOf } from 'murow/gpu/dsl';

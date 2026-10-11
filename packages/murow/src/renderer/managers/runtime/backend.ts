import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';
/**
 * Renderer backend seam.
 *
 * The renderer never compiles shaders or allocates raw GPU resources itself:
 * a platform package (for example `murow/webgpu`) installs an implementation
 * via {@link configureRendererBackend}. A different backend, or a user, can
 * install its own. Until one is installed, GPU-touching calls throw.
 */

/** The GPU operations the renderer needs from a backend. */
export interface RendererBackendImpl {
    /** Compile linked shaders to target source. */
    compile(shaders: readonly unknown[]): { code: string };
    /** Allocate a raw buffer from a schema and usage. */
    createRawBuffer(device: RawDevice, schema: unknown, usage?: unknown): RawBuffer;
    /** Build a native bind group layout from a descriptor. */
    createBindGroupLayout(device: RawDevice, descriptor: unknown): RawBindGroupLayout;
}

let current: RendererBackendImpl | undefined;

/** Install the backend the renderer drives. Called by a platform package. */
export function configureRendererBackend(backend: RendererBackendImpl): void {
    current = backend;
}

/** The installed backend. */
export function getRendererBackend(): RendererBackendImpl {
    if (!current) throw new Error('murow/renderer: no GPU backend configured');
    return current;
}

/** Compile shaders with the installed backend. */
export function compileProgram(shaders: readonly unknown[]): { code: string } {
    return getRendererBackend().compile(shaders);
}

/** Allocate a raw buffer with the installed backend. */
export function createRawBuffer(device: RawDevice, schema: unknown, usage?: unknown): RawBuffer {
    return getRendererBackend().createRawBuffer(device, schema, usage);
}

/** Build a bind group layout with the installed backend. */
export function createGpuBindGroupLayout(device: RawDevice, descriptor: unknown): RawBindGroupLayout {
    return getRendererBackend().createBindGroupLayout(device, descriptor);
}

export { sizeOf } from 'murow/gpu/dsl';

/** Compute is backend-specific; a platform package installs an implementation. */
export interface ComputeProvider {
    ComputeBuilder: new (...args: any[]) => any;
    ComputeManager: new (...args: any[]) => any;
    buildAnimationKernel(...args: any[]): any;
    uploadPackedToKernel(...args: any[]): any;
    packAnimationData(...args: any[]): any;
}

let computeProvider: ComputeProvider | undefined;

/** Install the compute implementation. Called by a platform package. */
export function configureComputeProvider(provider: ComputeProvider): void {
    computeProvider = provider;
}

/** The installed compute provider. */
export function getComputeProvider(): ComputeProvider {
    if (!computeProvider) throw new Error('murow/renderer: no compute provider configured');
    return computeProvider;
}

/** Proxy class that constructs the installed backend's ComputeBuilder. */
export const ComputeBuilder: new (...args: any[]) => any = new Proxy(function () {} as never, {
    construct: (_t, args) => new (getComputeProvider().ComputeBuilder)(...args),
}) as never;

/** Proxy class that constructs the installed backend's ComputeManager. */
export const ComputeManager: new (...args: any[]) => any = new Proxy(function () {} as never, {
    construct: (_t, args) => new (getComputeProvider().ComputeManager)(...args),
}) as never;


/** The present target a renderer draws to. Backend-specific (canvas/surface). */
export interface Presentation {
    readonly device: RawDevice;
    readonly format: RawTextureFormat;
    readonly context: RawCanvasContext;
    configure(descriptor: { alphaMode?: string }): void;
    getCurrentTexture(): { createView(): RawTextureView };
}

/** Builds a presentation (device + surface) for a canvas. */
export type PresentationFactory = (canvas: HTMLCanvasElement) => Promise<Presentation>;

let presentationFactory: PresentationFactory | undefined;
let currentPresentation: Presentation | undefined;

/** Install the presentation factory. Called by a platform package. */
export function configurePresentationFactory(factory: PresentationFactory): void {
    presentationFactory = factory;
}

/** Create and adopt the presentation for a canvas. */
export async function createPresentation(canvas: HTMLCanvasElement): Promise<Presentation> {
    if (!presentationFactory) throw new Error('murow/renderer: no presentation factory configured');
    currentPresentation = await presentationFactory(canvas);
    return currentPresentation;
}

/** The active presentation. */
export function getPresentation(): Presentation {
    if (!currentPresentation) throw new Error('murow/renderer: no presentation configured');
    return currentPresentation;
}


/** Backend-provided shader source by name (WGSL/GLSL/…). */
const shaderSources: Record<string, string> = {};

/** Register shader sources. Called by a platform package. */
export function configureShaderSources(sources: Record<string, string>): void {
    Object.assign(shaderSources, sources);
}

/** Source for a named shader helper. Empty when the backend provides none. */
export function getShaderSource(name: string): string {
    return shaderSources[name] ?? '';
}

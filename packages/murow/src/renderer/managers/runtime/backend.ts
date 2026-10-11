import type { RawCommandEncoder } from 'murow/gpu';
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

/**
 * Skeletal-animation backend port.
 *
 * The renderer drives skeletal animation only through this port; the WebGPU
 * package implements it with a compute kernel, another backend with CPU or a
 * vertex path. No kernel or builder type crosses the boundary.
 */
export interface AnimationKernelBudgets {
    skelI32Capacity: number;
    animF32Capacity: number;
    matricesCapacity: number;
}

/** Packed animation buffer sizes and table offsets (opaque payload). */
export interface PackedAnimationBuffers {
    readonly clipTableOffset: number;
    readonly channelTableOffset: number;
    readonly jointLookupOffset: number;
    readonly skelI32Length: number;
    readonly animF32Length: number;
    readonly totalMats: number;
}

/** Skeletal-animation simulation port. */
export interface Skinning {
    /** Pack CPU animation data and report its sizes/offsets. */
    pack(packed: unknown): PackedAnimationBuffers;
    /** Build/rebuild the simulation from packed data. */
    build(
        root: { device: RawDevice },
        packed: unknown,
        maxInstances: number,
        maxTotalBones: number,
        budgets: AnimationKernelBudgets,
    ): { buffers: PackedAnimationBuffers; budgets: AnimationKernelBudgets };
    /** Upload packed data into the current simulation (no rebuild). */
    upload(root: { device: RawDevice }, packed: unknown): void;
    /** Advance `count` instances with per-instance data and dispatch. */
    step(count: number, instData: Float32Array, buffers: PackedAnimationBuffers): void;
    /** The bone-matrix buffer the mesh pipeline binds, or null before build. */
    readonly boneBuffer: RawBuffer | null;
    /** Release the simulation. */
    destroy(): void;
}

/** A particle simulation driven by the renderer's particle manager. */
export interface ParticleSimulation {
    encodeSpawn(encoder: RawCommandEncoder, count: number): void;
    encodeIntegrate(encoder: RawCommandEncoder, count: number): void;
    encodeCompact(encoder: RawCommandEncoder, count: number): void;
    encodeArgs(encoder: RawCommandEncoder, maxMaterials: number): void;
    destroy(): void;
}

/** GPU particle backend port (compute on WebGPU, CPU/vertex elsewhere). */
export interface Particles3D {
    createSimulation(options: {
        root: { device: RawDevice };
        max: number;
        maxSpawns: number;
        maxMaterials: number;
        pool: RawBuffer;
        spawns: RawBuffer;
        frame: RawBuffer;
        counts: RawBuffer;
        indices: RawBuffer;
        args: RawBuffer;
    }): ParticleSimulation;
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
    /** Skeletal-animation simulation port. */
    readonly skinning: Skinning;
    /** GPU particle simulation port. */
    readonly particles: Particles3D;
}

export { sizeOf } from 'murow/gpu/dsl';

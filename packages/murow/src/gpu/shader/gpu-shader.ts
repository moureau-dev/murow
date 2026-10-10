/**
 * Shader authoring.
 *
 * A {@link GpuShader} pairs a stage and its in/out schema with a body that
 * receives `(input, bindings)` positionally. Resources are reached by property
 * name, which survives minification, so no name-based lookup is ever needed.
 *
 * The body is parsed to IR when a program is linked.
 */
import type { GpuType } from '../types';
import type { IrStage } from '../ir/nodes';
import type { GpuBindGroupLayout } from '../resources/bind-group';

/** A builtin input/output marker, for example the position output. */
export interface ShaderBuiltin {
    readonly __builtin: string;
    readonly type: GpuType;
}

/** A vertex input location marker, for example `d.location(0, d.vec3f)`. */
export interface ShaderLocation {
    readonly __location: number;
    readonly type: GpuType;
}

/** A value accepted in an input or output schema. */
export type ShaderIODesc = GpuType | ShaderBuiltin | ShaderLocation;

/** Mark a stage builtin input or output. */
export function builtin(name: string, type: GpuType): ShaderBuiltin {
    return { __builtin: name, type };
}

/** Whether a value is a builtin marker. */
export function isBuiltin(value: unknown): value is ShaderBuiltin {
    return typeof value === 'object' && value !== null && typeof (value as ShaderBuiltin).__builtin === 'string';
}

/** A named set of bind group layouts the body may reach by property. */
export type ShaderBindings = Record<string, GpuBindGroupLayout>;

/** The body of a shader: input first, bindings second, both positional. */
export type ShaderBody = (input: any, bindings: any) => unknown;

/** Options shared by every stage. */
export interface GpuShaderOptions {
    /** Vertex attributes or varyings, plus builtins, by name. */
    readonly in?: Record<string, ShaderIODesc>;
    /** Vertex outputs, by name, or a single fragment/compute result type. */
    readonly out?: Record<string, ShaderIODesc> | ShaderIODesc;
    /** Named bind group layouts. */
    readonly bindings?: ShaderBindings;
    /**
     * Flat names the body may destructure from its second parameter, resolved
     * to a slot path in a layout (`"mat.material"`) or a group of paths.
     */
    readonly expose?: Record<string, string | Record<string, string>>;
    /**
     * Named helper functions the body may call. They build IR and the backend
     * injects their source when the call appears. Functions only, never
     * resources.
     */
    readonly helpers?: Record<string, (...args: never[]) => unknown>;
    /** Compute workgroup size. */
    readonly workgroup?: readonly [number, number, number];
}

/** A stage definition to be linked by a {@link GpuProgram}. */
export class GpuShader<A = unknown, B = unknown> {
    /** Pipeline stage. */
    readonly stage: IrStage;
    /** Input schema. */
    readonly inputs: Record<string, ShaderIODesc>;
    /** Vertex output schema, or a single result type. */
    readonly outputs: Record<string, ShaderIODesc> | ShaderIODesc;
    /** Named bind group layouts. */
    readonly bindings: ShaderBindings;
    /** Flat names resolved to layout slot paths. */
    readonly expose: Record<string, string | Record<string, string>>;
    /** Named helper functions. */
    readonly helpers: Record<string, (...args: never[]) => unknown>;
    /** Workgroup size for compute. */
    readonly workgroup: readonly [number, number, number] | undefined;
    /** Source body. */
    readonly body: ShaderBody;

    private constructor(
        stage: IrStage,
        options: GpuShaderOptions,
        body: ShaderBody,
    ) {
        this.stage = stage;
        this.inputs = options.in ?? {};
        this.outputs = options.out ?? {};
        this.bindings = options.bindings ?? {};
        this.expose = options.expose ?? {};
        this.helpers = options.helpers ?? {};
        this.workgroup = options.workgroup;
        this.body = body;
    }

    /** Define a vertex shader. */
    static vertex(options: GpuShaderOptions & { out: Record<string, ShaderIODesc> }, body: ShaderBody): GpuShader {
        // (kept as a record: vertex output structs are named)
        return new GpuShader('vertex', options, body);
    }

    /** Define a fragment shader. */
    static fragment(options: GpuShaderOptions, body: ShaderBody): GpuShader {
        return new GpuShader('fragment', options, body);
    }

    /** Define a compute shader. */
    static compute(options: GpuShaderOptions & { workgroup: readonly [number, number, number] }, body: ShaderBody): GpuShader {
        return new GpuShader('compute', options, body);
    }
}

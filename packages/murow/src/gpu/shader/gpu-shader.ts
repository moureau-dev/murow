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

/** A builtin input marker, for example the position output. */
export interface ShaderBuiltin {
    readonly __builtin: string;
    readonly type: GpuType;
}

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
    readonly in?: Record<string, GpuType | ShaderBuiltin>;
    /** Vertex outputs. Ignored for other stages. */
    readonly out?: Record<string, GpuType | ShaderBuiltin>;
    /** Named bind group layouts. */
    readonly bindings?: ShaderBindings;
    /** Compute workgroup size. */
    readonly workgroup?: readonly [number, number, number];
}

/** A stage definition to be linked by a {@link GpuProgram}. */
export class GpuShader {
    /** Pipeline stage. */
    readonly stage: IrStage;
    /** Input schema. */
    readonly inputs: Record<string, GpuType | ShaderBuiltin>;
    /** Vertex output schema. */
    readonly outputs: Record<string, GpuType | ShaderBuiltin>;
    /** Named bind group layouts. */
    readonly bindings: ShaderBindings;
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
        this.workgroup = options.workgroup;
        this.body = body;
    }

    /** Define a vertex shader. */
    static vertex(options: GpuShaderOptions & { out: Record<string, GpuType | ShaderBuiltin> }, body: ShaderBody): GpuShader {
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

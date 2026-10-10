/**
 * Program linking.
 *
 * A {@link GpuProgram} lowers one or more {@link GpuShader}s to IR. Bind group
 * layouts are numbered in first-use order, so the emitted source and the
 * pipeline layout agree. The ordered layouts are what a pipeline needs.
 */
import type { GpuType } from '../types';
import type { IrEntry, IrOutput } from '../ir/nodes';
import { output as outputNode } from '../ir/builders';
import { parseShaderBody } from '../compiler/parse';
import type { GpuBindGroupLayout } from '../resources/bind-group';
import { isBuiltin, type GpuShader, type ShaderBuiltin } from './gpu-shader';

/** A linked program: lowered entries and their layouts in group order. */
export class GpuProgram {
    /** Lowered entries, one per shader. */
    readonly entries: readonly IrEntry[];
    /** Layouts in bind group order. */
    readonly layouts: readonly GpuBindGroupLayout[];

    private constructor(entries: readonly IrEntry[], layouts: readonly GpuBindGroupLayout[]) {
        this.entries = entries;
        this.layouts = layouts;
    }

    /** Link shaders, assigning bind group indices in first-use order. */
    static link(shaders: readonly GpuShader[]): GpuProgram {
        const layouts: GpuBindGroupLayout[] = [];
        const groupOf = (layout: GpuBindGroupLayout): number => {
            const found = layouts.indexOf(layout);
            if (found >= 0) return found;
            layouts.push(layout);
            return layouts.length - 1;
        };
        // Assign groups before parsing so binding nodes carry the right index.
        for (const shader of shaders) {
            for (const name of Object.keys(shader.bindings)) groupOf(shader.bindings[name]!);
        }
        for (let i = 0; i < layouts.length; i++) layouts[i]!.group = i;

        const entries = shaders.map((shader) => linkShader(shader));
        return new GpuProgram(entries, layouts);
    }
}

/** Lower one shader to IR. */
function linkShader(shader: GpuShader): IrEntry {
    const params: Record<string, GpuType> = {};
    const builtins: Record<string, GpuType> = {};
    const builtinNames: Record<string, string> = {};
    for (const name of Object.keys(shader.inputs)) {
        const spec = shader.inputs[name]!;
        if (isBuiltin(spec)) {
            builtins[name] = spec.type;
            builtinNames[name] = spec.__builtin;
        } else {
            params[name] = spec;
        }
    }
    const outputs = shader.stage === 'vertex' ? buildOutputs(shader.outputs) : undefined;
    return parseShaderBody(shader.body.toString(), {
        stage: shader.stage,
        params,
        builtins,
        builtinNames,
        ...(outputs ? { outputs } : {}),
        bindings: shader.bindings,
        ...(shader.workgroup ? { workgroupSize: shader.workgroup } : {}),
    });
}

function buildOutputs(schema: Record<string, GpuType | ShaderBuiltin>): IrOutput[] | undefined {
    const outputs: IrOutput[] = [];
    let location = 0;
    for (const name of Object.keys(schema)) {
        const spec = schema[name]!;
        if (isBuiltin(spec)) outputs.push(outputNode(name, spec.type, { builtin: spec.__builtin }));
        else outputs.push(outputNode(name, spec, { location: location++ }));
    }
    return outputs.length > 0 ? outputs : undefined;
}

/**
 * Program linking.
 *
 * A {@link GpuProgram} lowers one or more {@link GpuShader}s to IR. Bind group
 * layouts are numbered in first-use order, so the emitted source and the
 * pipeline layout agree. The ordered layouts are what a pipeline needs.
 */
import type { GpuType } from '../types';
import type { IrEntry, IrOutput } from '../ir/nodes';
import { binding as bindingNode, output as outputNode } from '../ir/builders';
import { ShaderValue } from '../dsl/value';
import { parseShaderBody } from '../compiler/parse';
import type { GpuBindGroupLayout } from '../resources/bind-group';
import { isBuiltin, type GpuShader, type ShaderBuiltin, type ShaderIODesc } from './gpu-shader';

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
            params[name] = inputType(spec);
        }
    }
    const outputs = shader.stage === 'vertex' && isOutputRecord(shader.outputs)
        ? buildOutputs(shader.outputs)
        : undefined;
    const source = shader.body.toString();
    return parseShaderBody(source, {
        stage: shader.stage,
        params,
        builtins,
        builtinNames,
        ...(outputs ? { outputs } : {}),
        bindings: buildBindings(shader),
        ...(Object.keys(shader.helpers).length > 0 ? { externals: shader.helpers } : {}),
        ...(shader.workgroup ? { workgroupSize: shader.workgroup } : {}),
    });
}

/** Layout names plus flat `expose` paths, as the parser expects them. */
function buildBindings(shader: GpuShader): Record<string, unknown> {
    const out: Record<string, unknown> = { ...shader.bindings };
    for (const name of Object.keys(shader.expose)) {
        out[name] = resolveExpose(shader.expose[name]!, shader.bindings);
    }
    return out;
}

/** Resolve an expose path to a binding value, or a record of binding values. */
function resolveExpose(target: string | Record<string, string>, layouts: Record<string, GpuBindGroupLayout>): unknown {
    if (typeof target === 'string') {
        const [layoutName, slotName] = target.split('.');
        const layout = layouts[layoutName!];
        const slot = layout?.slot(slotName!);
        if (!layout || !slot) throw new Error(`GpuShader: expose path '${target}' does not resolve`);
        const node = bindingNode(slot.type, layout.group, slot.binding);
        if (slot.readwrite) (node as { access?: string }).access = 'read_write';
        return new ShaderValue({ node });
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(target)) record[key] = resolveExpose(target[key]!, layouts);
    return record;
}

/** Whether an output spec is a named record (a vertex output struct). */
function isOutputRecord(value: unknown): value is Record<string, ShaderIODesc> {
    if (typeof value !== 'object' || value === null) return false;
    return !isBuiltin(value) && (value as { kind?: string }).kind === undefined;
}

/** The IR type behind an input/output description: a bare type, or a `.type` marker. */
function inputType(spec: ShaderIODesc): GpuType {
    const candidate = spec as { type?: GpuType };
    if (candidate && typeof candidate === 'object' && candidate.type && typeof candidate.type.kind === 'string') {
        return candidate.type;
    }
    return spec as GpuType;
}

function buildOutputs(schema: Record<string, ShaderIODesc>): IrOutput[] | undefined {
    const outputs: IrOutput[] = [];
    let location = 0;
    for (const name of Object.keys(schema)) {
        const spec = schema[name]!;
        if (isBuiltin(spec)) outputs.push(outputNode(name, spec.type, { builtin: spec.__builtin }));
        else outputs.push(outputNode(name, inputType(spec), { location: location++ }));
    }
    return outputs.length > 0 ? outputs : undefined;
}

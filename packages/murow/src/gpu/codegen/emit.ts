/**
 * The code-generation driver.
 *
 * `emitEntry` lowers an entry through the shared and backend passes, then walks
 * it to source. The walker is target-agnostic: struct, binding, type, and
 * keyword text all come from the backend's {@link TargetSyntax}.
 */
import type { GpuType, StructType } from '../types';
import type { IrBinding, IrEntry } from '../ir/nodes';
import { walkEntry } from '../ir/nodes';
import {
    createEmitContext,
    defaultEntryName,
    indentText,
    type Backend,
    type CodegenResult,
} from './backend';
import { PassPipeline, SHARED_PASSES } from './passes';

/** A whole module: several lowered entries, shared structs, bindings, and helpers. */
export interface ProgramResult {
    readonly code: string;
    readonly stages: readonly CodegenResult[];
}

/** Options accepted by {@link emitProgram}. */
export interface EmitProgramOptions {
    /** Helper source injected ahead of the bindings, already filtered to used helpers. */
    readonly helpers?: string;
}

/**
 * Lower several entries through the passes, then emit one module: shared struct
 * declarations, any vertex output structs, helper source, binding declarations,
 * and each entry point. Target strings all come from the backend's syntax.
 */
export function emitProgram(
    entries: readonly IrEntry[],
    backend: Backend,
    options: EmitProgramOptions = {},
): ProgramResult {
    const pipeline = new PassPipeline({ shared: SHARED_PASSES, backend: backend.passes });
    const lowered = entries.map((entry) => pipeline.run(entry));
    const ctx = createEmitContext(backend);
    const sections: string[] = [];

    for (const type of collectStructs(lowered)) sections.push(backend.syntax.structDecl(type));
    for (const entry of lowered) {
        if (hasOutputs(entry)) sections.push(backend.syntax.outputStructDecl(entry));
    }
    if (options.helpers && options.helpers.length > 0) sections.push(options.helpers);

    for (const binding of collectProgramBindings(lowered)) {
        const declaration = backend.declareBinding(binding, ctx);
        if (declaration.length > 0) sections.push(declaration);
    }

    for (const entry of lowered) {
        sections.push(`${backend.entryPointSignature(entry, ctx)} {`);
        ctx.indent = 1;
        for (const stmt of entry.body) sections.push(indentText(ctx.indent) + backend.emitNode(stmt, ctx));
        ctx.indent = 0;
        sections.push('}');
    }

    return { code: sections.join('\n'), stages: lowered.map((entry) => ({ code: '', stage: entry.stage, entryName: defaultEntryName(entry) })) };
}

/** Names of calls in the entries that match a provided helper table, in stable order. */
export function collectHelperNames(entries: readonly IrEntry[], helpers: Readonly<Record<string, string>>): string[] {
    const found: string[] = [];
    for (const entry of entries) {
        walkEntry(entry, (node) => {
            if (node.kind !== 'call') return;
            const name = (node as { name: string }).name;
            if (!(name in helpers) || found.includes(name)) return;
            found.push(name);
        });
    }
    return found;
}

function hasOutputs(entry: IrEntry): boolean {
    return entry.stage === 'vertex' && entry.outputs !== undefined && entry.outputs.length > 0;
}

function collectStructs(entries: readonly IrEntry[]): StructType[] {
    const out: StructType[] = [];
    for (const entry of entries) {
        walkEntry(entry, (node) => {
            if (node.kind !== 'binding') return;
            collectStructTypes(node.type, out);
        });
    }
    return out;
}

function collectStructTypes(type: GpuType, out: StructType[]): void {
    if (type.kind === 'array') {
        collectStructTypes(type.element, out);
        return;
    }
    if (type.kind !== 'struct') return;
    if (out.some((s) => s.name === type.name)) return;
    out.push(type);
    for (const field of type.fields) collectStructTypes(field.type, out);
}

function collectProgramBindings(entries: readonly IrEntry[]): IrBinding[] {
    const out: IrBinding[] = [];
    for (const entry of entries) {
        walkEntry(entry, (node) => {
            if (node.kind !== 'binding') return;
            const binding = node as IrBinding;
            if (!out.some((b) => b.group === binding.group && b.binding === binding.binding)) out.push(binding);
        });
    }
    return out;
}

/**
 * Lower an entry through the shared and backend passes, then emit its source.
 */
export function emitEntry(entry: IrEntry, backend: Backend): CodegenResult {
    const pipeline = new PassPipeline({ shared: SHARED_PASSES, backend: backend.passes });
    const lowered = pipeline.run(entry);
    const ctx = createEmitContext(backend);

    const sections: string[] = [];
    const preamble = backend.preamble(lowered, ctx);
    if (preamble.length > 0) sections.push(preamble);

    for (const binding of collectBindings(lowered)) {
        const declaration = backend.declareBinding(binding, ctx);
        if (declaration.length > 0) sections.push(declaration);
    }

    sections.push(`${backend.entryPointSignature(lowered, ctx)} {`);
    ctx.indent = 1;
    for (const stmt of lowered.body) {
        sections.push(indentText(ctx.indent) + backend.emitNode(stmt, ctx));
    }
    ctx.indent = 0;
    sections.push('}');

    return { code: sections.join('\n'), stage: lowered.stage, entryName: defaultEntryName(lowered) };
}

function collectBindings(entry: IrEntry): IrBinding[] {
    const found: IrBinding[] = [];
    walkEntry(entry, (node) => {
        if (node.kind !== 'binding') return;
        const binding = node as IrBinding;
        if (!found.some((b) => b.group === binding.group && b.binding === binding.binding)) {
            found.push(binding);
        }
    });
    return found;
}

/**
 * The code-generation driver.
 *
 * `emitEntry` lowers an entry through the shared and backend passes, then walks
 * it to source. The walker is target-agnostic: struct, binding, type, and
 * keyword text all come from the backend's {@link TargetSyntax}.
 */
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

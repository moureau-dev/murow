/**
 * The code-generation driver and the default WGSL backend.
 *
 * `emitEntry` lowers an entry through the shared and backend passes, then emits
 * source. `WgslBackend` is `BaseBackend` with all capabilities enabled, plus the
 * WGSL-specific pieces the base hooks leave open: casts, loop control flow,
 * named and storage bindings, struct auto-declaration, and an injectable
 * preamble for helper functions.
 */
import type { GpuType, StructType } from '../types';
import { wgslType } from '../types';
import type {
    IrBinding,
    IrEntry,
    IrExpr,
    IrStmt,
} from '../ir/nodes';
import { walkEntry } from '../ir/nodes';
import {
    BaseBackend,
    bindingName,
    createEmitContext,
    defaultEntryName,
    indentText,
    type BaseBackendOptions,
    type Backend,
    type CodegenResult,
    type EmitContext,
} from './backend';
import { PassPipeline, SHARED_PASSES } from './passes';

/** How a bound resource is addressed in the emitted source. */
export type BindingKind = 'uniform' | 'storage' | 'texture' | 'sampler';

/** Access mode of a storage buffer. */
export type StorageAccess = 'read' | 'read_write';

/** Per-binding emission hint, matched by group and binding slot. */
export interface BindingHint {
    readonly group: number;
    readonly binding: number;
    readonly kind: BindingKind;
    readonly name?: string;
    readonly access?: StorageAccess;
}

/** Optional role fields an IR binding may already carry. */
interface BindingWithHint extends IrBinding {
    readonly bindingKind?: BindingKind;
    readonly name?: string;
    readonly access?: StorageAccess;
}

/** Options accepted by {@link WgslBackend}. */
export interface WgslBackendOptions extends BaseBackendOptions {
    /** WGSL helper functions injected ahead of the entry point. */
    readonly helpers?: string;
    /** Role hints for bindings, matched by group and binding slot. */
    readonly bindings?: readonly BindingHint[];
}

/**
 * The default WGSL emitter. It inherits every WGSL-compatible hook from
 * `BaseBackend` and enables all capabilities.
 */
export class WgslBackend extends BaseBackend {
    private readonly bindingHints: readonly BindingHint[];
    private readonly injected: string[] = [];

    constructor(options: WgslBackendOptions = {}) {
        super({
            ...options,
            name: options.name ?? 'wgsl',
            capabilities: {
                compute: true,
                storageBuffers: true,
                f16: true,
                subgroups: true,
                ...(options.capabilities ?? {}),
            },
        });
        this.bindingHints = options.bindings ?? [];
        if (options.helpers) this.injected.push(options.helpers);
    }

    /** Append WGSL text (helper functions or struct declarations) to the preamble. */
    addPreamble(text: string): void {
        if (text.length > 0) this.injected.push(text);
    }

    /** Emit a node, handling casts and loop control flow the base does not. */
    override emitNode(node: IrExpr | IrStmt, ctx: EmitContext): string {
        const custom = this.nodes.get(node.kind);
        if (custom) return custom(node, ctx);
        switch (node.kind) {
            case 'cast':
                return `${wgslType(node.type)}(${this.emitNode(node.value, ctx)})`;
            case 'break':
                return 'break;';
            case 'continue':
                return 'continue;';
            case 'binding':
                return this.nameOfBinding(node);
            default:
                return super.emitNode(node, ctx);
        }
    }

    /** Declaration of a bound resource, honouring kind, name, and access hints. */
    override declareBinding(binding: IrBinding, _ctx: EmitContext): string {
        const hint = this.hintOf(binding);
        const ir = binding as BindingWithHint;
        const kind = ir.bindingKind ?? hint?.kind ?? inferBindingKind(binding.type);
        const name = this.nameOfBinding(binding);
        const access = ir.access ?? hint?.access;
        const head = `@group(${binding.group}) @binding(${binding.binding})`;

        switch (kind) {
            case 'texture':
            case 'sampler':
                return `${head} var ${name}: ${wgslType(binding.type)};`;
            case 'storage': {
                const mode = access ? `, ${access}` : '';
                return `${head} var<storage${mode}> ${name}: ${wgslType(binding.type)};`;
            }
            case 'uniform':
            default:
                return `${head} var<uniform> ${name}: ${wgslType(binding.type)};`;
        }
    }

    /** Struct declarations, auto-discovered binding structs, then injected text. */
    override preamble(entry: IrEntry, _ctx: EmitContext): string {
        const parts: string[] = [];
        for (const type of mergeStructs(this.structs, collectBindingStructs(entry))) {
            parts.push(emitStructDeclaration(type));
        }
        for (const text of this.injected) {
            if (text.length > 0) parts.push(text);
        }
        return parts.join('\n');
    }

    private hintOf(binding: IrBinding): BindingHint | undefined {
        return this.bindingHints.find(
            (hint) => hint.group === binding.group && hint.binding === binding.binding,
        );
    }

    private nameOfBinding(binding: IrBinding): string {
        const ir = binding as BindingWithHint;
        return ir.name ?? this.hintOf(binding)?.name ?? bindingName(binding);
    }
}

/**
 * Lower an entry through the shared and backend passes, then emit its source.
 */
export function emitEntry(entry: IrEntry, backend: Backend = new WgslBackend()): CodegenResult {
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

/** Infer the binding role from its type when no hint is supplied. */
function inferBindingKind(type: GpuType): BindingKind {
    if (type.kind === 'texture') return 'texture';
    if (type.kind === 'sampler') return 'sampler';
    if (type.kind === 'array') return 'storage';
    return 'uniform';
}

/** Declared structs first, then any struct referenced by a binding. */
function mergeStructs(
    declared: readonly StructType[],
    discovered: readonly StructType[],
): StructType[] {
    const out: StructType[] = [];
    for (const type of declared) if (!out.some((s) => s.name === type.name)) out.push(type);
    for (const type of discovered) if (!out.some((s) => s.name === type.name)) out.push(type);
    return out;
}

function collectBindingStructs(entry: IrEntry): StructType[] {
    const found: StructType[] = [];
    walkEntry(entry, (node) => {
        if (node.kind === 'binding') collectStructsFromType(node.type, found);
    });
    return found;
}

function collectStructsFromType(type: GpuType, out: StructType[]): void {
    if (type.kind === 'array') {
        collectStructsFromType(type.element, out);
        return;
    }
    if (type.kind !== 'struct') return;
    if (out.some((s) => s.name === type.name)) return;
    out.push(type);
    for (const field of type.fields) collectStructsFromType(field.type, out);
}

function emitStructDeclaration(type: StructType): string {
    const fields = type.fields
        .map((field) => `    ${field.name}: ${wgslType(field.type)},`)
        .join('\n');
    return `struct ${type.name} {\n${fields}\n}`;
}

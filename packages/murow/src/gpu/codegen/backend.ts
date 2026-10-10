/**
 * The code-generation backend contract and its target-agnostic base
 * implementation.
 *
 * A backend advertises capabilities, orders lowering passes, supplies the emit
 * hooks, and delegates every target-specific string to a {@link TargetSyntax}.
 * `BaseBackend` implements the walker once, so a target supplies only its
 * syntax and capability flags.
 */
import type { StructType, GpuType } from '../types';
import type {
    IrBinding,
    IrBuiltin,
    IrEntry,
    IrExpr,
    IrLiteral,
    IrStmt,
} from '../ir/nodes';
import { isExpr, walkEntry } from '../ir/nodes';
import { IntrinsicRegistry, NodeRegistry } from './registry';
import type { LoweringPass } from './passes';
import type { BindingHint, BindingKind, StorageAccess, TargetSyntax } from './syntax';

/** Features a target may or may not support. */
export interface Capabilities {
    readonly compute: boolean;
    readonly storageBuffers: boolean;
    readonly f16: boolean;
    readonly subgroups: boolean;
}

/** Every capability enabled. */
export const ALL_CAPABILITIES: Capabilities = Object.freeze({
    compute: true,
    storageBuffers: true,
    f16: true,
    subgroups: true,
});

/** Every capability disabled. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({
    compute: false,
    storageBuffers: false,
    f16: false,
    subgroups: false,
});

/** Emitted source plus the stage and entry name it belongs to. */
export interface CodegenResult {
    readonly code: string;
    readonly stage: IrEntry['stage'];
    readonly entryName: string;
}

/** One indentation step. */
export const INDENT = '    ';

/** Indentation string for a nesting level. */
export function indentText(level: number): string {
    return INDENT.repeat(level);
}

/**
 * Lexical scope table mapping local ids to names. Frames are pushed for nested
 * blocks. Backed by parallel arrays. No `Map`.
 */
export class ScopeTable {
    private readonly ids: number[][] = [[]];
    private readonly names: string[][] = [[]];

    /** Enter a nested block. */
    push(): void {
        this.ids.push([]);
        this.names.push([]);
    }

    /** Leave the innermost block. The root frame is never removed. */
    pop(): void {
        if (this.ids.length > 1) {
            this.ids.pop();
            this.names.pop();
        }
    }

    /** Bind an id to a name in the current frame. */
    define(id: number, name: string): void {
        const top = this.ids.length - 1;
        this.ids[top].push(id);
        this.names[top].push(name);
    }

    /** Name bound to an id, searching inner frames first. */
    nameOf(id: number): string | undefined {
        for (let frame = this.ids.length - 1; frame >= 0; frame--) {
            const frameIds = this.ids[frame];
            for (let i = frameIds.length - 1; i >= 0; i--) {
                if (frameIds[i] === id) return this.names[frame][i];
            }
        }
        return undefined;
    }

    /** Whether an id is bound. */
    has(id: number): boolean {
        return this.nameOf(id) !== undefined;
    }
}

/** Mutable state threaded through emission. */
export interface EmitContext {
    readonly backend: Backend;
    indent: number;
    readonly scopes: ScopeTable;
}

/** Create a fresh emit context for a backend. */
export function createEmitContext(backend: Backend): EmitContext {
    return { backend, indent: 0, scopes: new ScopeTable() };
}

/**
 * A code generator for one target language. The hooks are target-neutral; the
 * backend resolves the actual text through its {@link TargetSyntax}.
 */
export interface Backend {
    readonly name: string;
    readonly capabilities: Capabilities;
    readonly passes: readonly LoweringPass[];
    readonly syntax: TargetSyntax;
    emitNode(node: IrExpr | IrStmt, ctx: EmitContext): string;
    mapBuiltin(builtin: IrBuiltin, ctx: EmitContext): string;
    entryPointSignature(entry: IrEntry, ctx: EmitContext): string;
    declareBinding(binding: IrBinding, ctx: EmitContext): string;
    preamble(entry: IrEntry, ctx: EmitContext): string;
    readonly intrinsics: IntrinsicRegistry;
}

/** Options accepted by {@link BaseBackend}. */
export interface BaseBackendOptions {
    /** Target syntax. Required: the base owns no target strings of its own. */
    readonly syntax: TargetSyntax;
    readonly name?: string;
    readonly capabilities?: Partial<Capabilities>;
    readonly passes?: readonly LoweringPass[];
    readonly nodes?: NodeRegistry;
    readonly intrinsics?: IntrinsicRegistry;
    readonly structs?: readonly StructType[];
    /** Role hints for bindings, matched by group and binding slot. */
    readonly bindings?: readonly BindingHint[];
    /** Opaque helper source injected ahead of the entry point. */
    readonly helpers?: string;
}

/** Name of a binding's generated variable. */
export function bindingName(binding: IrBinding): string {
    return `binding_${binding.group}_${binding.binding}`;
}

/** Entry function name for a stage. */
export function defaultEntryName(entry: IrEntry): string {
    switch (entry.stage) {
        case 'vertex':
            return 'vs_main';
        case 'fragment':
            return 'fs_main';
        case 'compute':
            return 'cs_main';
    }
}

/** Direct-passthrough intrinsics shared by all backends. */
export const DIRECT_INTRINSICS: readonly string[] = [
    'dot',
    'cross',
    'normalize',
    'length',
    'distance',
    'reflect',
    'refract',
    'max',
    'min',
    'clamp',
    'mix',
    'step',
    'smoothstep',
    'abs',
    'sign',
    'floor',
    'ceil',
    'fract',
    'round',
    'trunc',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'atan2',
    'sinh',
    'cosh',
    'tanh',
    'pow',
    'exp',
    'exp2',
    'log',
    'log2',
    'sqrt',
    'inverseSqrt',
    'select',
    'all',
    'any',
    'transpose',
    'determinant',
];

/** Binary operator spellings shared by all targets. */
export const OPERATOR_INTRINSICS: Readonly<Record<string, string>> = Object.freeze({
    add: '+',
    sub: '-',
    mul: '*',
    div: '/',
    mod: '%',
});

/** Build the default intrinsic registry. */
export function createDefaultIntrinsics(): IntrinsicRegistry {
    const registry = new IntrinsicRegistry();
    for (const name of DIRECT_INTRINSICS) {
        registry.register(name, (args, ctx) =>
            `${name}(${args.map((arg) => ctx.backend.emitNode(arg, ctx)).join(', ')})`,
        );
    }
    for (const name of Object.keys(OPERATOR_INTRINSICS)) {
        const op = OPERATOR_INTRINSICS[name]!;
        registry.register(name, (args, ctx) => {
            const left = ctx.backend.emitNode(args[0]!, ctx);
            const right = ctx.backend.emitNode(args[1]!, ctx);
            return `(${left} ${op} ${right})`;
        });
    }
    registry.register('neg', (args, ctx) => `(-${ctx.backend.emitNode(args[0]!, ctx)})`);
    return registry;
}

/** Optional role fields an IR binding may already carry. */
interface BindingWithHint extends IrBinding {
    readonly bindingKind?: BindingKind;
    readonly name?: string;
    readonly access?: StorageAccess;
}

/**
 * Target-agnostic backend. It walks the IR once and resolves every target
 * string through the supplied syntax.
 */
export class BaseBackend implements Backend {
    readonly name: string;
    readonly capabilities: Capabilities;
    readonly passes: readonly LoweringPass[];
    readonly nodes: NodeRegistry;
    readonly intrinsics: IntrinsicRegistry;
    readonly structs: readonly StructType[];
    readonly syntax: TargetSyntax;

    private readonly bindingHints: readonly BindingHint[];
    private readonly injected: string[] = [];

    constructor(options: BaseBackendOptions) {
        this.syntax = options.syntax;
        this.name = options.name ?? options.syntax.name;
        this.capabilities = { ...NO_CAPABILITIES, ...(options.capabilities ?? {}) };
        this.passes = options.passes ?? [];
        this.nodes = options.nodes ?? new NodeRegistry();
        this.intrinsics = options.intrinsics ?? createDefaultIntrinsics();
        this.structs = options.structs ?? [];
        this.bindingHints = options.bindings ?? [];
        if (options.helpers) this.injected.push(options.helpers);
    }

    /** Append opaque preamble text, for example helper functions. */
    addPreamble(text: string): void {
        if (text.length > 0) this.injected.push(text);
    }

    /** Emit any node. A registered node emitter takes precedence. */
    emitNode(node: IrExpr | IrStmt, ctx: EmitContext): string {
        const custom = this.nodes.get(node.kind);
        if (custom) return custom(node, ctx);
        return isExpr(node) ? this.emitExpr(node, ctx) : this.emitStmt(node, ctx);
    }

    /** Attribute for a stage builtin. */
    mapBuiltin(builtin: IrBuiltin, _ctx: EmitContext): string {
        return this.syntax.builtin(builtin.name);
    }

    /** Declaration of a bound resource, honouring kind, name, and access hints. */
    declareBinding(binding: IrBinding, _ctx: EmitContext): string {
        const hint = this.hintOf(binding);
        const ir = binding as BindingWithHint;
        const kind = ir.bindingKind ?? hint?.kind ?? inferBindingKind(binding.type);
        const access = ir.access ?? hint?.access;
        return this.syntax.declareBinding(binding, kind, access, this.nameOfBinding(binding));
    }

    /** Prefix, struct declarations, vertex output struct, then injected text. */
    preamble(entry: IrEntry, _ctx: EmitContext): string {
        const parts: string[] = [];
        const prefix = this.syntax.preamblePrefix();
        if (prefix.length > 0) parts.push(prefix);
        for (const type of mergeStructs(this.structs, collectBindingStructs(entry))) {
            parts.push(this.syntax.structDecl(type));
        }
        if (hasVertexOutputs(entry)) {
            parts.push(this.syntax.outputStructDecl(entry));
        }
        for (const text of this.injected) {
            if (text.length > 0) parts.push(text);
        }
        return parts.join('\n');
    }

    /** Entry attribute plus function signature and return type. */
    entryPointSignature(entry: IrEntry, ctx: EmitContext): string {
        const params: string[] = [];
        for (const p of entry.params) {
            params.push(this.syntax.paramDecl(p.location, p.name, p.type));
        }
        for (const builtin of collectBuiltins(entry)) {
            if (entry.stage === 'vertex' && builtin.name === 'position') continue;
            params.push(
                `${this.mapBuiltin(builtin, ctx)} ${builtin.name}: ${this.syntax.typeName(builtin.type)}`,
            );
        }

        if (hasVertexOutputs(entry)) {
            return this.syntax.entrySignature(
                entry,
                params,
                defaultEntryName(entry),
                this.syntax.outputStructName(entry),
            );
        }

        const head = this.syntax.entrySignature(entry, params, defaultEntryName(entry));
        const value = firstReturnValue(entry);
        const type = value ? value.type : DEFAULT_RETURN_TYPE;
        return head + this.syntax.returnType(entry.stage, type);
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

    private emitExpr(node: IrExpr, ctx: EmitContext): string {
        switch (node.kind) {
            case 'literal':
                return this.emitLiteral(node);
            case 'local':
                return ctx.scopes.nameOf(node.id) ?? `v${node.id}`;
            case 'binding':
                return this.nameOfBinding(node);
            case 'builtin':
                return node.name;
            case 'unary':
                return `(${node.op}${this.emitNode(node.value, ctx)})`;
            case 'binary':
                return `(${this.emitNode(node.left, ctx)} ${node.op} ${this.emitNode(node.right, ctx)})`;
            case 'construct':
                return this.syntax.construct(
                    node.type,
                    node.args.map((arg) => this.emitNode(arg, ctx)),
                );
            case 'swizzle':
                return `${this.emitNode(node.value, ctx)}.${node.mask}`;
            case 'access':
                if (node.index === 'columns') return this.emitNode(node.value, ctx);
                return typeof node.index === 'string'
                    ? `${this.emitNode(node.value, ctx)}.${node.index}`
                    : `${this.emitNode(node.value, ctx)}[${this.emitNode(node.index, ctx)}]`;
            case 'call': {
                const impl = this.intrinsics.get(node.name);
                if (impl) return impl([...node.args], ctx);
                return `${node.name}(${node.args.map((arg) => this.emitNode(arg, ctx)).join(', ')})`;
            }
            case 'sample':
                return this.syntax.sample(
                    this.emitNode(node.texture, ctx),
                    this.emitNode(node.sampler, ctx),
                    this.emitNode(node.coords, ctx),
                );
            case 'cast':
                return this.syntax.cast(node.type, this.emitNode(node.value, ctx));
        }
    }

    private emitStmt(node: IrStmt, ctx: EmitContext): string {
        switch (node.kind) {
            case 'let': {
                const name = `v${node.id}`;
                ctx.scopes.define(node.id, name);
                return this.syntax.declareLet(name, node.type, this.emitNode(node.value, ctx));
            }
            case 'assign':
                return `${this.emitNode(node.target, ctx)} = ${this.emitNode(node.value, ctx)};`;
            case 'if':
                return this.emitIf(node, ctx);
            case 'loop':
                return this.emitLoop(node, ctx);
            case 'return':
                return node.value ? `return ${this.emitNode(node.value, ctx)};` : 'return;';
            case 'discard':
                return this.syntax.discard();
            case 'break':
                return this.syntax.break();
            case 'continue':
                return this.syntax.continue();
        }
    }

    private emitIf(node: Extract<IrStmt, { kind: 'if' }>, ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        const cond = this.emitNode(node.cond, ctx);

        ctx.indent++;
        ctx.scopes.push();
        const thenBody = this.emitBlock(node.then, ctx);
        ctx.scopes.pop();
        ctx.indent--;

        let out = `if (${cond}) {\n${thenBody}\n${pad}}`;
        if (node.otherwise) {
            ctx.indent++;
            ctx.scopes.push();
            const elseBody = this.emitBlock(node.otherwise, ctx);
            ctx.scopes.pop();
            ctx.indent--;
            out += ` else {\n${elseBody}\n${pad}}`;
        }
        return out;
    }

    private emitLoop(node: Extract<IrStmt, { kind: 'loop' }>, ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        ctx.indent++;
        ctx.scopes.push();
        const body = this.emitBlock(node.body, ctx);
        ctx.scopes.pop();
        ctx.indent--;
        return this.syntax.loop(`${body}\n${pad}`);
    }

    private emitBlock(stmts: readonly IrStmt[], ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        return stmts.map((stmt) => pad + this.emitNode(stmt, ctx)).join('\n');
    }

    private emitLiteral(node: IrLiteral): string {
        const type = node.type;
        if (type.kind === 'scalar') {
            if (typeof node.value === 'boolean') {
                return this.syntax.literal(type, node.value ? 'true' : 'false');
            }
            if (typeof node.value === 'number') {
                return this.syntax.literal(type, this.syntax.formatScalar(type.scalar, node.value));
            }
            return this.syntax.literal(type, `${node.value}`);
        }
        const scalar = type.kind === 'vec' || type.kind === 'mat' ? type.scalar : 'f32';
        const values = Array.isArray(node.value) ? node.value : [node.value as number];
        return this.syntax.construct(
            type,
            values.map((value) => this.syntax.formatScalar(scalar, value as number)),
        );
    }
}

/** Fallback entry return type when no return value is present. */
const DEFAULT_RETURN_TYPE: GpuType = { kind: 'vec', scalar: 'f32', width: 4 };

/** Whether a vertex entry returns a struct of varyings. */
function hasVertexOutputs(entry: IrEntry): boolean {
    return entry.stage === 'vertex'
        && entry.outputs !== undefined
        && entry.outputs.length > 0;
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

function collectBuiltins(entry: IrEntry): IrBuiltin[] {
    const found: IrBuiltin[] = [];
    walkEntry(entry, (node) => {
        if (node.kind !== 'builtin') return;
        const builtin = node as IrBuiltin;
        // A builtin whose name is also an entry parameter is the parameter's
        // reference in the body, not a separate stage builtin to declare.
        if (entry.params.some((p) => p.name === builtin.name)) return;
        if (!found.some((b) => b.name === builtin.name)) found.push(builtin);
    });
    return found;
}

function firstReturnValue(entry: IrEntry): IrExpr | null {
    let result: IrExpr | null = null;
    walkEntry(entry, (node) => {
        if (result) return;
        if (node.kind === 'return' && node.value) result = node.value;
    });
    return result;
}

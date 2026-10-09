/**
 * The code-generation backend contract and its default (WGSL-compatible)
 * implementation.
 *
 * A backend advertises capabilities, orders lowering passes, and supplies the
 * emit hooks. `BaseBackend` implements every hook with WGSL output so a backend
 * overrides only what differs.
 */
import type { StructType, GpuType } from '../types';
import { wgslType } from '../types';
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
 * A code generator for one target language. Hooks have WGSL-compatible defaults
 * in `BaseBackend`; a backend overrides only the ones that differ.
 */
export interface Backend {
    readonly name: string;
    readonly capabilities: Capabilities;
    readonly passes: readonly LoweringPass[];
    emitNode(node: IrExpr | IrStmt, ctx: EmitContext): string;
    mapBuiltin(builtin: IrBuiltin, ctx: EmitContext): string;
    entryPointSignature(entry: IrEntry, ctx: EmitContext): string;
    declareBinding(binding: IrBinding, ctx: EmitContext): string;
    preamble(entry: IrEntry, ctx: EmitContext): string;
    readonly intrinsics: IntrinsicRegistry;
}

/** Options accepted by {@link BaseBackend}. */
export interface BaseBackendOptions {
    readonly name?: string;
    readonly capabilities?: Partial<Capabilities>;
    readonly passes?: readonly LoweringPass[];
    readonly nodes?: NodeRegistry;
    readonly intrinsics?: IntrinsicRegistry;
    readonly structs?: readonly StructType[];
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

/** Build the default intrinsic registry. */
export function createDefaultIntrinsics(): IntrinsicRegistry {
    const registry = new IntrinsicRegistry();
    for (const name of DIRECT_INTRINSICS) {
        registry.register(name, (args, ctx) =>
            `${name}(${args.map((arg) => ctx.backend.emitNode(arg, ctx)).join(', ')})`,
        );
    }
    return registry;
}

/**
 * Default backend. Every hook emits WGSL, so a target that is WGSL-compatible
 * overrides only capability flags, passes, or individual hooks.
 */
export class BaseBackend implements Backend {
    readonly name: string;
    readonly capabilities: Capabilities;
    readonly passes: readonly LoweringPass[];
    readonly nodes: NodeRegistry;
    readonly intrinsics: IntrinsicRegistry;
    readonly structs: readonly StructType[];

    constructor(options: BaseBackendOptions = {}) {
        this.name = options.name ?? 'base';
        this.capabilities = { ...NO_CAPABILITIES, ...(options.capabilities ?? {}) };
        this.passes = options.passes ?? [];
        this.nodes = options.nodes ?? new NodeRegistry();
        this.intrinsics = options.intrinsics ?? createDefaultIntrinsics();
        this.structs = options.structs ?? [];
    }

    /** Emit any node. A registered node emitter takes precedence. */
    emitNode(node: IrExpr | IrStmt, ctx: EmitContext): string {
        const custom = this.nodes.get(node.kind);
        if (custom) return custom(node, ctx);
        return isExpr(node) ? this.emitExpr(node, ctx) : this.emitStmt(node, ctx);
    }

    /** Attribute for a stage builtin. */
    mapBuiltin(builtin: IrBuiltin, _ctx: EmitContext): string {
        switch (builtin.name) {
            case 'position':
            case 'frag_coord':
                return '@builtin(position)';
            case 'front_facing':
                return '@builtin(front_facing)';
            case 'invocation_id':
                return '@builtin(global_invocation_id)';
            default:
                return `@builtin(${builtin.name})`;
        }
    }

    /** Declaration of a bound resource. */
    declareBinding(binding: IrBinding, _ctx: EmitContext): string {
        const address = addressSpaceOf(binding.type);
        return `@group(${binding.group}) @binding(${binding.binding}) ${address} ${bindingName(binding)}: ${wgslType(binding.type)};`;
    }

    /** Struct declarations supplied to the backend. */
    preamble(_entry: IrEntry, _ctx: EmitContext): string {
        return this.structs.map((type) => emitStruct(type)).join('\n');
    }

    /** Entry attribute plus function signature. */
    entryPointSignature(entry: IrEntry, ctx: EmitContext): string {
        const attribute =
            entry.stage === 'compute'
                ? `@compute @workgroup_size(${(entry.workgroupSize ?? [1, 1, 1]).join(', ')})`
                : `@${entry.stage}`;

        const params: string[] = [];
        for (const p of entry.params) {
            params.push(`@location(${p.location}) ${p.name}: ${wgslType(p.type)}`);
        }
        for (const builtin of collectBuiltins(entry)) {
            if (entry.stage === 'vertex' && builtin.name === 'position') continue;
            params.push(`${this.mapBuiltin(builtin, ctx)} ${builtin.name}: ${wgslType(builtin.type)}`);
        }

        const signature = `${attribute}\nfn ${defaultEntryName(entry)}(${params.join(', ')})`;
        return signature + this.returnType(entry);
    }

    private returnType(entry: IrEntry): string {
        if (entry.stage === 'compute') return '';
        const value = firstReturnValue(entry);
        const type = value ? wgslType(value.type) : 'vec4<f32>';
        return entry.stage === 'vertex'
            ? ` -> @builtin(position) ${type}`
            : ` -> @location(0) ${type}`;
    }

    private emitExpr(node: IrExpr, ctx: EmitContext): string {
        switch (node.kind) {
            case 'literal':
                return this.emitLiteral(node);
            case 'local':
                return ctx.scopes.nameOf(node.id) ?? `v${node.id}`;
            case 'binding':
                return bindingName(node);
            case 'builtin':
                return node.name;
            case 'unary':
                return `(${node.op}${this.emitNode(node.value, ctx)})`;
            case 'binary':
                return `(${this.emitNode(node.left, ctx)} ${node.op} ${this.emitNode(node.right, ctx)})`;
            case 'construct':
                return `${wgslType(node.type)}(${node.args.map((arg) => this.emitNode(arg, ctx)).join(', ')})`;
            case 'swizzle':
                return `${this.emitNode(node.value, ctx)}.${node.mask}`;
            case 'access':
                return typeof node.index === 'string'
                    ? `${this.emitNode(node.value, ctx)}.${node.index}`
                    : `${this.emitNode(node.value, ctx)}[${this.emitNode(node.index, ctx)}]`;
            case 'call': {
                const impl = this.intrinsics.get(node.name);
                if (impl) return impl([...node.args], ctx);
                return `${node.name}(${node.args.map((arg) => this.emitNode(arg, ctx)).join(', ')})`;
            }
            case 'sample':
                return `textureSample(${this.emitNode(node.texture, ctx)}, ${this.emitNode(node.sampler, ctx)}, ${this.emitNode(node.coords, ctx)})`;
        }
    }

    private emitStmt(node: IrStmt, ctx: EmitContext): string {
        switch (node.kind) {
            case 'let': {
                const name = `v${node.id}`;
                ctx.scopes.define(node.id, name);
                return `let ${name}: ${wgslType(node.type)} = ${this.emitNode(node.value, ctx)};`;
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
                return 'discard;';
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
        return `loop {\n${body}\n${pad}}`;
    }

    private emitBlock(stmts: readonly IrStmt[], ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        return stmts.map((stmt) => pad + this.emitNode(stmt, ctx)).join('\n');
    }

    private emitLiteral(node: IrLiteral): string {
        const type = node.type;
        if (type.kind === 'scalar') {
            if (typeof node.value === 'boolean') return node.value ? 'true' : 'false';
            if (typeof node.value === 'number') return formatNumber(type.scalar, node.value);
            return `${node.value}`;
        }
        const scalar = type.kind === 'vec' || type.kind === 'mat' ? type.scalar : 'f32';
        const values = Array.isArray(node.value) ? node.value : [node.value as number];
        return `${wgslType(type)}(${values.map((value) => formatNumber(scalar, value as number)).join(', ')})`;
    }
}

/** Address space qualifier for a binding's type. */
export function addressSpaceOf(type: GpuType): string {
    if (type.kind === 'texture' || type.kind === 'sampler') return 'var';
    if (type.kind === 'array' && type.count === null) return 'var<storage>';
    return 'var<uniform>';
}

function formatNumber(scalar: string, value: number): string {
    if (scalar === 'u32') return `${Math.trunc(value)}u`;
    if (scalar === 'i32') return String(Math.trunc(value));
    return formatF32(value);
}

function formatF32(value: number): string {
    return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function emitStruct(type: StructType): string {
    const fields = type.fields
        .map((field) => `    ${field.name}: ${wgslType(field.type)},`)
        .join('\n');
    return `struct ${type.name} {\n${fields}\n}`;
}

function collectBuiltins(entry: IrEntry): IrBuiltin[] {
    const found: IrBuiltin[] = [];
    walkEntry(entry, (node) => {
        if (node.kind !== 'builtin') return;
        const builtin = node as IrBuiltin;
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

/**
 * GLSL ES 3.0 code generation backend.
 *
 * Emits `#version 300 es` source for vertex and fragment entries. GLSL has no
 * compute stage and no storage buffers, so those constructs are rejected with a
 * clear error instead of being silently mistranslated. Textures and samplers
 * are merged because GLSL binds them as one `sampler2D` uniform.
 */
import { glslType, type GpuType, type StructType } from '../types';
import type {
    IrBinding,
    IrBuiltin,
    IrEntry,
    IrExpr,
    IrLiteral,
    IrStage,
    IrStmt,
} from '../ir/nodes';
import { isExpr, walkEntry } from '../ir/nodes';
import {
    BaseBackend,
    DIRECT_INTRINSICS,
    bindingName,
    indentText,
    type BaseBackendOptions,
    type EmitContext,
} from './backend';
import { IntrinsicRegistry } from './registry';

/** Fragment color output variable name. */
export const GLSL_COLOR_OUTPUT = 'fragColor';

/** Options accepted by {@link GlslBackend}. */
export interface GlslBackendOptions extends BaseBackendOptions {}

/**
 * The GLSL ES 3.0 emitter. Overrides the WGSL-compatible hooks with GLSL
 * syntax, folds separate textures and samplers into one `sampler2D`, and
 * disables compute and storage buffers.
 */
export class GlslBackend extends BaseBackend {
    private stage: IrStage | null = null;

    constructor(options: GlslBackendOptions = {}) {
        super({
            ...options,
            name: options.name ?? 'glsl',
            capabilities: {
                compute: false,
                storageBuffers: false,
                f16: false,
                subgroups: false,
                ...(options.capabilities ?? {}),
            },
            intrinsics: options.intrinsics ?? createGlslIntrinsics(),
        });
    }

    /** Emit any node. A registered node emitter takes precedence. */
    emitNode(node: IrExpr | IrStmt, ctx: EmitContext): string {
        const custom = this.nodes.get(node.kind);
        if (custom) return custom(node, ctx);
        return isExpr(node) ? this.emitExprNode(node, ctx) : this.emitStmtNode(node, ctx);
    }

    /** GLSL variable for a stage builtin. */
    mapBuiltin(builtin: IrBuiltin, _ctx: EmitContext): string {
        switch (builtin.name) {
            case 'position':
                return 'gl_Position';
            case 'frag_coord':
                return 'gl_FragCoord';
            case 'front_facing':
                return 'gl_FrontFacing';
            case 'instance_index':
                return 'gl_InstanceID';
            default:
                return builtin.name;
        }
    }

    /**
     * One top-level binding declaration. A sampler emits nothing because its
     * texture already declares the combined `sampler2D`.
     */
    declareBinding(binding: IrBinding, _ctx: EmitContext): string {
        const type = binding.type;
        if (type.kind === 'sampler') return '';

        const name = bindingName(binding);
        if (type.kind === 'texture') {
            return `uniform ${glslType(type)} ${name};`;
        }
        if (type.kind === 'array') {
            if (type.count === null) {
                throw new Error(
                    'GlslBackend: storage buffers are not supported in GLSL ES 3.0',
                );
            }
            return `uniform ${glslType(type.element)} ${name}[${type.count}];`;
        }
        if (type.kind === 'struct') {
            const members = type.fields
                .map((field) => `    ${glslMember(field.type, field.name)};`)
                .join('\n');
            return `layout(std140) uniform ${name} {\n${members}\n};`;
        }
        return `uniform ${glslTypeOf(type)} ${name};`;
    }

    /** GLSL header, structs, and the stage interface. */
    preamble(entry: IrEntry, _ctx: EmitContext): string {
        this.assertStage(entry);
        this.stage = entry.stage;

        const lines: string[] = [
            '#version 300 es',
            'precision highp float;',
            'precision highp int;',
        ];

        for (const type of this.structs) lines.push(emitStruct(type));

        for (const p of entry.params) {
            lines.push(`layout(location = ${p.location}) in ${glslTypeOf(p.type)} ${p.name};`);
        }

        if (entry.stage === 'fragment') {
            const value = firstReturnValue(entry);
            lines.push(`out ${value ? glslTypeOf(value.type) : 'vec4'} ${GLSL_COLOR_OUTPUT};`);
        }

        return lines.join('\n');
    }

    /** GLSL has a single `void main` entry point for every stage. */
    entryPointSignature(entry: IrEntry, _ctx: EmitContext): string {
        this.assertStage(entry);
        this.stage = entry.stage;
        return 'void main()';
    }

    private assertStage(entry: IrEntry): void {
        if (entry.stage === 'compute') {
            throw new Error('GlslBackend: compute shaders are not supported in GLSL ES 3.0');
        }
    }

    private emitExprNode(node: IrExpr, ctx: EmitContext): string {
        switch (node.kind) {
            case 'literal':
                return this.emitLiteralValue(node);
            case 'local':
                return ctx.scopes.nameOf(node.id) ?? `v${node.id}`;
            case 'binding':
                return bindingName(node);
            case 'builtin':
                return this.mapBuiltin(node, ctx);
            case 'unary':
                return `(${node.op}${this.emitNode(node.value, ctx)})`;
            case 'binary':
                return `(${this.emitNode(node.left, ctx)} ${node.op} ${this.emitNode(node.right, ctx)})`;
            case 'construct':
                return `${glslTypeOf(node.type)}(${node.args.map((arg) => this.emitNode(arg, ctx)).join(', ')})`;
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
                return `texture(${this.emitNode(node.texture, ctx)}, ${this.emitNode(node.coords, ctx)})`;
            case 'cast':
                return `${glslTypeOf(node.type)}(${this.emitNode(node.value, ctx)})`;
        }
    }

    private emitStmtNode(node: IrStmt, ctx: EmitContext): string {
        switch (node.kind) {
            case 'let': {
                const name = `v${node.id}`;
                ctx.scopes.define(node.id, name);
                return `${glslTypeOf(node.type)} ${name} = ${this.emitNode(node.value, ctx)};`;
            }
            case 'assign':
                return `${this.emitNode(node.target, ctx)} = ${this.emitNode(node.value, ctx)};`;
            case 'if':
                return this.emitIfNode(node, ctx);
            case 'loop':
                return this.emitLoopNode(node, ctx);
            case 'return':
                return this.emitReturnValue(node.value, ctx);
            case 'discard':
                return 'discard;';
            case 'break':
                return 'break;';
            case 'continue':
                return 'continue;';
        }
    }

    private emitReturnValue(value: IrExpr | null, ctx: EmitContext): string {
        if (!value) return 'return;';
        if (this.stage === 'vertex') return `gl_Position = ${this.emitNode(value, ctx)};`;
        if (this.stage === 'fragment') {
            return `${GLSL_COLOR_OUTPUT} = ${this.emitNode(value, ctx)};`;
        }
        return `return ${this.emitNode(value, ctx)};`;
    }

    private emitIfNode(node: Extract<IrStmt, { kind: 'if' }>, ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        const cond = this.emitNode(node.cond, ctx);

        ctx.indent++;
        ctx.scopes.push();
        const thenBody = this.emitBlockNodes(node.then, ctx);
        ctx.scopes.pop();
        ctx.indent--;

        let out = `if (${cond}) {\n${thenBody}\n${pad}}`;
        if (node.otherwise) {
            ctx.indent++;
            ctx.scopes.push();
            const elseBody = this.emitBlockNodes(node.otherwise, ctx);
            ctx.scopes.pop();
            ctx.indent--;
            out += ` else {\n${elseBody}\n${pad}}`;
        }
        return out;
    }

    private emitLoopNode(node: Extract<IrStmt, { kind: 'loop' }>, ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        ctx.indent++;
        ctx.scopes.push();
        const body = this.emitBlockNodes(node.body, ctx);
        ctx.scopes.pop();
        ctx.indent--;
        return `while (true) {\n${body}\n${pad}}`;
    }

    private emitBlockNodes(stmts: readonly IrStmt[], ctx: EmitContext): string {
        const pad = indentText(ctx.indent);
        return stmts.map((stmt) => pad + this.emitNode(stmt, ctx)).join('\n');
    }

    private emitLiteralValue(node: IrLiteral): string {
        const type = node.type;
        if (type.kind === 'scalar') {
            if (typeof node.value === 'boolean') return node.value ? 'true' : 'false';
            if (typeof node.value === 'number') return formatNumber(type.scalar, node.value);
            return `${node.value}`;
        }
        const scalar = type.kind === 'vec' || type.kind === 'mat' ? type.scalar : 'f32';
        const values = Array.isArray(node.value) ? node.value : [node.value as number];
        return `${glslTypeOf(type)}(${values.map((value) => formatNumber(scalar, value as number)).join(', ')})`;
    }
}

/**
 * GLSL intrinsic registry. Names shared with GLSL pass through; a few WGSL
 * spellings are remapped.
 */
export function createGlslIntrinsics(): IntrinsicRegistry {
    const registry = new IntrinsicRegistry();
    for (const name of DIRECT_INTRINSICS) registry.register(name, direct(name));

    registry.register('mod', direct('mod'));
    registry.override('inverseSqrt', direct('inversesqrt'));
    registry.override('atan2', direct('atan'));
    registry.override('select', (args, ctx) => {
        const [falsy, truthy, cond] = args;
        return `(${ctx.backend.emitNode(cond, ctx)} ? ${ctx.backend.emitNode(truthy, ctx)} : ${ctx.backend.emitNode(falsy, ctx)})`;
    });
    return registry;
}

/** GLSL spelling of a type, correcting scalar names the shared helper leaves as `f32`/`i32`/`u32`. */
function glslTypeOf(type: GpuType): string {
    if (type.kind === 'scalar') {
        if (type.scalar === 'f32') return 'float';
        if (type.scalar === 'i32') return 'int';
        if (type.scalar === 'u32') return 'uint';
        return 'bool';
    }
    return glslType(type);
}

function direct(name: string) {
    return (args: IrExpr[], ctx: EmitContext) =>
        `${name}(${args.map((arg) => ctx.backend.emitNode(arg, ctx)).join(', ')})`;
}

function glslMember(type: GpuType, name: string): string {
    if (type.kind === 'array') {
        if (type.count === null) {
            throw new Error('GlslBackend: runtime-sized arrays are not supported in GLSL ES 3.0');
        }
        return `${glslTypeOf(type.element)} ${name}[${type.count}]`;
    }
    return `${glslTypeOf(type)} ${name}`;
}

function emitStruct(type: StructType): string {
    const members = type.fields
        .map((field) => `    ${glslMember(field.type, field.name)};`)
        .join('\n');
    return `struct ${type.name} {\n${members}\n};`;
}

function formatNumber(scalar: string, value: number): string {
    if (scalar === 'u32') return `${Math.trunc(value)}u`;
    if (scalar === 'i32') return String(Math.trunc(value));
    return formatF32(value);
}

function formatF32(value: number): string {
    return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function firstReturnValue(entry: IrEntry): IrExpr | null {
    let result: IrExpr | null = null;
    walkEntry(entry, (node) => {
        if (result) return;
        if (node.kind === 'return' && node.value) result = node.value;
    });
    return result;
}

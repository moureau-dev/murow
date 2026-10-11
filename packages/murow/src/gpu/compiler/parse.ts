/**
 * Build-time source front-end.
 *
 * Parses a DSL shader body (from `Function.prototype.toString`) and lowers it
 * to the IR. This is what lets authors write native operators (`a * b`),
 * `if`/`else`, and `for`/`while` loops instead of `std.mul(a, b)` and
 * `branch(...)`.
 *
 * Hand-written tokenizer, Pratt expression parser, and a small statement
 * parser. No parser dependency, so nothing extra is shipped. Calls like
 * `s.normalize(x)` resolve against the DSL's `std` namespace, and `d.u32(x)`
 * lowers to an IR cast, so the intrinsic set stays in one place.
 */
import type { GpuType } from '../types';
import {
    bool as boolType,
    f32 as f32Type,
    i32 as i32Type,
    u32 as u32Type,
} from '../ir/types';
import {
    access,
    assignStmt,
    binary,
    breakStmt,
    builtin,
    call,
    cast,
    construct,
    continueStmt,
    discardStmt,
    entry,
    field,
    ifStmt,
    letStmt,
    literal,
    local,
    loopStmt,
    param,
    returnStmt,
    struct as structType,
    swizzle,
    unary,
    type IrEntry,
    type IrExpr,
    type IrOutput,
    type IrParam,
    type IrStmt,
    type IrStage,
} from '../ir';
import { ShaderValue, toExpr } from '../dsl/value';
import { std as stdLib } from '../dsl/std';
import { d as dLib } from '../dsl/data';
import { binding } from '../ir/builders';

/** Options describing the entry to build from parsed source. */
export interface ParseShaderOptions {
    readonly stage: IrStage;
    readonly params?: Record<string, GpuType>;
    /** Stage builtin inputs, by source name, for entry parameters. */
    readonly builtins?: Record<string, GpuType>;
    /** WGSL/protocol builtin spelling for a source name (for example `instance_index`). */
    readonly builtinNames?: Record<string, string>;
    readonly material?: Record<string, GpuType>;
    /**
     * Named bind group layouts the body reaches through its second parameter.
     * Each layout contributes a view whose slots resolve to binding nodes.
     */
    readonly bindings?: Readonly<Record<string, unknown>>;
    readonly workgroupSize?: readonly [number, number, number];
    /**
     * Vertex outputs in declaration order. When present, a body that returns an
     * object literal is lowered to a construction of the output struct, so the
     * emitter can declare the struct and return it.
     */
    readonly outputs?: readonly IrOutput[];
    /**
     * Extra named symbols the body may reference, resolved as bare identifiers.
     * A backend registers its environment here (layouts, scene uniforms, engine
     * helpers) so the parser stays target- and engine-agnostic. Members are
     * resolved by property access on the value, so a layout object can expose
     * `.$.name` accessors that yield IR.
     */
    readonly externals?: Record<string, unknown>;
}

interface Token {
    readonly kind: 'num' | 'ident' | 'punc' | 'str' | 'eof';
    readonly value: string;
    readonly start: number;
}

const PUNCTUATORS = [
    '===', '!==', '=>', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '<<', '>>',
    '{', '}', '(', ')', '[', ']', ';', ',', '.', ':', '?',
    '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^',
];

function isIdentStart(ch: string): boolean {
    return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
    return /[A-Za-z0-9_$]/.test(ch);
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
        const ch = source[i]!;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if (ch === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let j = i + 1;
            while (j < source.length && source[j] !== ch) { if (source[j] === '\\') j++; j++; }
            tokens.push({ kind: 'str', value: source.slice(i, j + 1), start: i });
            i = j + 1;
            continue;
        }
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
            const start = i;
            while (i < source.length && /[0-9.]/.test(source[i]!)) i++;
            if (source[i] === 'e' || source[i] === 'E') {
                let j = i + 1;
                if (source[j] === '+' || source[j] === '-') j++;
                if (/[0-9]/.test(source[j] ?? '')) {
                    i = j;
                    while (i < source.length && /[0-9]/.test(source[i]!)) i++;
                }
            }
            if (source[i] === 'f') i++;
            tokens.push({ kind: 'num', value: source.slice(start, i).replace(/f$/, ''), start });
            continue;
        }
        if (isIdentStart(ch)) {
            const start = i;
            while (i < source.length && isIdentPart(source[i]!)) i++;
            tokens.push({ kind: 'ident', value: source.slice(start, i), start });
            continue;
        }
        let matched = false;
        for (const punct of PUNCTUATORS) {
            if (source.startsWith(punct, i)) {
                tokens.push({ kind: 'punc', value: punct, start: i });
                i += punct.length;
                matched = true;
                break;
            }
        }
        if (!matched) throw new Error(`parseShader: unexpected character '${ch}' at ${i}`);
    }
    tokens.push({ kind: 'eof', value: '', start: source.length });
    return tokens;
}

const SWIZZLE = /^[xyzwrgba]{1,4}$/;

/** Lower a parsed DSL shader body into an IR entry. */
export function parseShaderBody(source: string, options: ParseShaderOptions): IrEntry {
    const parser = new Parser(tokenize(source), options);
    return parser.parseEntry();
}

/** Compile a DSL shader function by parsing its source. */
export function parseShaderFunction(
    fn: (...args: never[]) => unknown,
    options: ParseShaderOptions,
): IrEntry {
    return parseShaderBody(fn.toString(), options);
}

class Parser {
    private pos = 0;
    private nextLocal = 0;
    private readonly locals: Record<string, IrExpr> = Object.create(null);
    private readonly params: Record<string, ShaderValue> = Object.create(null);
    private readonly material: Record<string, ShaderValue | Record<string, ShaderValue>> = Object.create(null);
    private namespaceParams = '';
    private namespaceMaterial = '';
    private namespaceStd = '';
    /** Names bound by destructured parameters, mapped to their namespace kind. */
    private readonly destructured: Record<string, 'params' | 'material' | 'std'> = Object.create(null);
    /** Destructured local name -> bound slot key (they differ when a bundler renames the local). */
    private readonly destructuredKey: Record<string, string> = Object.create(null);

    constructor(
        private readonly tokens: Token[],
        private readonly options: ParseShaderOptions,
    ) {}

    parseEntry(): IrEntry {
        this.parseArrowHeader();
        buildSchemas(this.options, this.params, this.material);
        const body = this.startsBlock() ? this.parseBlock() : [returnStmt(this.exprOf(this.parseExpression()))];
        const params: IrParam[] = [];
        let location = 0;
        for (const name of Object.keys(this.options.params ?? {})) {
            params.push(param(name, (this.options.params as Record<string, GpuType>)[name]!, location++));
        }
        return entry({
            stage: this.options.stage,
            params,
            body,
            ...(this.options.workgroupSize ? { workgroupSize: this.options.workgroupSize } : {}),
            ...(this.options.outputs && this.options.outputs.length > 0 ? { outputs: this.options.outputs } : {}),
        });
    }

    private parseArrowHeader(): void {
        // Accept `(a, b, c) =>`, `a =>`, `({ a, b }) =>`, or a plain `{ ... }` body.
        if (this.startsBlock()) return;
        const names: Array<string | Array<{ name: string; key: string }>> = [];
        const readPattern = (): string | Array<{ name: string; key: string }> => {
            if (this.peekPunc('{')) {
                this.next();
                const bound: Array<{ name: string; key: string }> = [];
                while (!this.peekPunc('}')) {
                    const key = this.next();
                    if (key.kind !== 'ident') throw this.error('expected a bind name', key);
                    let binding = key.value;
                    if (this.peekPunc(':')) {
                        this.next();
                        binding = this.next().value;
                    }
                    bound.push({ name: binding, key: key.value });
                    if (this.peekPunc(',')) this.next();
                }
                this.expectPunc('}');
                return bound;
            }
            const t = this.next();
            if (t.kind !== 'ident') throw this.error('expected a parameter name', t);
            return t.value;
        };
        if (this.peekPunc('(')) {
            this.next();
            while (!this.peekPunc(')')) {
                names.push(readPattern());
                if (this.peekPunc(',')) this.next();
            }
            this.expectPunc(')');
        } else if (this.peekKind('ident') || this.peekPunc('{')) {
            names.push(readPattern());
        }
        if (this.peekPunc('=>')) this.next();
        // Positional namespaces: params, material, std. A destructured list binds
        // each name straight to its positional namespace.
        const kinds: Array<'params' | 'material' | 'std'> = ['params', 'material', 'std'];
        for (let i = 0; i < names.length; i++) {
            const entry = names[i]!;
            const kind = kinds[i] ?? 'params';
            if (Array.isArray(entry)) for (const b of entry) { this.destructured[b.name] = kind; this.destructuredKey[b.name] = b.key; }
        }
        const first = names[0];
        const second = names[1];
        const third = names[2];
        this.namespaceParams = typeof first === 'string' ? first : 'v';
        this.namespaceMaterial = typeof second === 'string' ? second : 'm';
        this.namespaceStd = typeof third === 'string' ? third : 's';
    }

    private parseBlock(): IrStmt[] {
        this.expectPunc('{');
        const body: IrStmt[] = [];
        while (!this.peekPunc('}') && !this.peekKind('eof')) {
            if (this.peekKind('str')) { this.next(); this.consumeSemicolon(); continue; }
            for (const stmt of this.parseStatement()) body.push(stmt);
        }
        this.expectPunc('}');
        return body;
    }

    private parseStatement(): IrStmt[] {
        const token = this.peek();
        if (token.kind === 'ident') {
            if (token.value === 'const' || token.value === 'let' || token.value === 'var') return this.parseVarDecl();
            if (token.value === 'return') return [this.parseReturn()];
            if (token.value === 'if') return [this.parseIf()];
            if (token.value === 'for') return this.parseFor();
            if (token.value === 'while') return this.parseWhile();
            if (token.value === 'do') return this.parseDo();
            if (token.value === 'break') {
                this.next();
                this.consumeSemicolon();
                return [breakStmt()];
            }
            if (token.value === 'continue') {
                this.next();
                this.consumeSemicolon();
                return [continueStmt()];
            }
            if (token.value === 'discard') {
                this.next();
                this.consumeSemicolon();
                return [discardStmt()];
            }
        }
        // Expression statement, possibly a comma sequence (`a = x, b = y`).
        const stmts: IrStmt[] = [];
        for (;;) {
            const expr = this.parseExpression();
            if (isStmtNode(expr)) stmts.push(expr as IrStmt);
            if (this.peekPunc(',')) { this.next(); continue; }
            break;
        }
        this.consumeSemicolon();
        if (stmts.length > 0) return stmts;
        throw this.error('parseShader: unsupported expression statement');
    }

    /**
     * `for (init; cond; update) body`.
     *
     * Lowers to the init statements followed by a loop whose first statement
     * breaks when the condition fails, and whose tail runs the update.
     */
    private parseFor(): IrStmt[] {
        this.next();
        this.expectPunc('(');
        const init: IrStmt[] = [];
        if (this.peekPunc(';')) {
            this.next();
        } else {
            const head = this.peek();
            if (head.kind === 'ident' && (head.value === 'const' || head.value === 'let' || head.value === 'var')) {
                init.push(...this.parseVarDecl());
            } else {
                const expr = this.parseExpression();
                this.consumeSemicolon();
                if (isStmtNode(expr)) init.push(expr as IrStmt);
            }
        }
        let cond: IrExpr | null = null;
        if (!this.peekPunc(';')) cond = this.exprOf(this.parseExpression());
        this.expectPunc(';');
        const update: IrStmt[] = [];
        if (!this.peekPunc(')')) {
            const expr = this.parseExpression();
            if (isStmtNode(expr)) update.push(expr as IrStmt);
        }
        this.expectPunc(')');
        const body = this.parseLoopBody();
        return [...init, loopStmt(loopBody(cond, body, update))];
    }

    /** `while (cond) body`. */
    private parseWhile(): IrStmt[] {
        this.next();
        this.expectPunc('(');
        const cond = this.exprOf(this.parseExpression());
        this.expectPunc(')');
        return [loopStmt(loopBody(cond, this.parseLoopBody(), []))];
    }

    /** `do body while (cond);`. */
    private parseDo(): IrStmt[] {
        this.next();
        const body = this.parseLoopBody();
        if (!(this.peekKind('ident') && this.peek().value === 'while')) {
            throw this.error("expected 'while' after a do body");
        }
        this.next();
        this.expectPunc('(');
        const cond = this.exprOf(this.parseExpression());
        this.expectPunc(')');
        this.consumeSemicolon();
        return [loopStmt([...body, ...loopTail(cond)])];
    }

    private parseLoopBody(): IrStmt[] {
        return this.startsBlock() ? this.parseBlock() : this.parseStatement();
    }

    private parseVarDecl(): IrStmt[] {
        this.next();
        const out: IrStmt[] = [];
        for (;;) {
            if (this.peekPunc('{')) {
                out.push(...this.parseObjectPatternDeclarator());
            } else {
                const name = this.next();
                if (name.kind !== 'ident') throw this.error('expected a variable name', name);
                this.expectPunc('=');
                const value = this.parseExpression();
                const stmt = this.bind(name.value, value);
                if (stmt) out.push(stmt);
            }
            if (this.peekPunc(',')) {
                this.next();
                continue;
            }
            break;
        }
        this.consumeSemicolon();
        return out;
    }

    /**
     * `{ a, b: c } = expr` inside a declaration list. Each binding lowers to a
     * member access on the initializer, stored as its own local. The trailing
     * comma, if any, is left for the caller.
     */
    private parseObjectPatternDeclarator(): IrStmt[] {
        this.next();
        const bindings: Array<{ key: string; name: string }> = [];
        while (!this.peekPunc('}')) {
            const key = this.next();
            if (key.kind !== 'ident') throw this.error('expected an object key', key);
            let name = key.value;
            if (this.peekPunc(':')) {
                this.next();
                const alias = this.next();
                if (alias.kind !== 'ident') throw this.error('expected a binding name', alias);
                name = alias.value;
            }
            bindings.push({ key: key.value, name });
            if (this.peekPunc(',')) this.next();
        }
        this.expectPunc('}');
        this.expectPunc('=');
        const source = this.parseExpression();
        const out: IrStmt[] = [];
        for (const binding of bindings) {
            const stmt = this.bind(binding.name, this.member(source, binding.key));
            if (stmt) out.push(stmt);
        }
        return out;
    }

    /**
     * Bind a value to a new local and emit its `let`. A storage resource is
     * aliased instead, since WGSL cannot copy a binding into a function local.
     */
    private bind(name: string, value: unknown): IrStmt | null {
        const expr = this.exprOf(value);
        if (expr.kind === 'binding') {
            this.locals[name] = expr;
            return null;
        }
        const id = this.nextLocal++;
        this.locals[name] = local(exprType(expr), id);
        return letStmt(id, this.locals[name]!.type, expr);
    }

    private parseReturn(): IrStmt {
        this.next();
        if (this.peekPunc(';') || this.peekPunc('}')) {
            if (this.peekPunc(';')) this.next();
            return returnStmt(null);
        }
        const value = this.parseExpression();
        this.consumeSemicolon();
        if (isObjectLiteral(value)) return returnStmt(this.buildOutputValue(value));
        return returnStmt(this.exprOf(value));
    }

    /**
     * Lower `return { field: expr, ... }` into a construction of the entry's
     * output struct. Fields follow `options.outputs` order, so the positional
     * constructor matches the emitted struct declaration.
     */
    private buildOutputValue(value: { __object: Array<{ key: string; value: IrExpr }> }): IrExpr {
        const outputs = this.options.outputs;
        if (!outputs || outputs.length === 0) {
            throw this.error('an object return requires `outputs` in the parse options');
        }
        const byName: Record<string, IrExpr> = Object.create(null);
        for (const entry of value.__object) byName[entry.key] = entry.value;
        const fields = outputs.map((output) => field(output.name, output.type));
        const args = outputs.map((output) => {
            const expr = byName[output.name];
            if (!expr) throw this.error(`missing output field '${output.name}'`);
            return expr;
        });
        return construct(structType('vs_out', fields), args);
    }

    private parseIf(): IrStmt {
        this.next();
        this.expectPunc('(');
        const cond = this.exprOf(this.parseExpression());
        this.expectPunc(')');
        const thenBody = this.startsBlock() ? this.parseBlock() : this.parseStatement();
        let elseBody: IrStmt[] | null = null;
        if (this.peekKind('ident') && this.peek().value === 'else') {
            this.next();
            elseBody = this.startsBlock() ? this.parseBlock() : this.parseStatement();
        }
        return ifStmt(cond, thenBody, elseBody);
    }

    // --- expressions -------------------------------------------------------

    private parseExpression(): unknown {
        return this.parseAssignment();
    }

    private parseAssignment(): unknown {
        const left = this.parseConditional();
        if (this.peekPunc('=')) {
            this.next();
            const value = this.parseAssignment();
            return assignStmt(this.exprOf(left), this.exprOf(value));
        }
        return left;
    }

    private parseConditional(): unknown {
        const cond = this.parseBinary(0);
        if (this.peekPunc('?')) {
            this.next();
            const a = this.parseAssignment();
            this.expectPunc(':');
            const b = this.parseAssignment();
            return intrinsic('select', [this.exprOf(cond), this.exprOf(a), this.exprOf(b)]);
        }
        return cond;
    }

    private readonly precedence: readonly (readonly string[])[] = [
        ['||'],
        ['&&'],
        ['|'],
        ['^'],
        ['&'],
        ['==', '!=', '===', '!=='],
        ['<', '<=', '>', '>='],
        ['<<', '>>'],
        ['+', '-'],
        ['*', '/', '%'],
    ];

    private parseBinary(level: number): unknown {
        if (level >= this.precedence.length) return this.parseUnary();
        let left = this.parseBinary(level + 1);
        while (this.peekPuncIn(this.precedence[level]!)) {
            const op = this.next().value;
            const right = this.parseBinary(level + 1);
            left = this.binaryOp(op, this.exprOf(left), this.exprOf(right));
        }
        return left;
    }

    private binaryOp(op: string, left: IrExpr, right: IrExpr): IrExpr {
        switch (op) {
            case '+': return intrinsic('add', [left, right]);
            case '-': return intrinsic('sub', [left, right]);
            case '*': return intrinsic('mul', [left, right]);
            case '/': return intrinsic('div', [left, right]);
            case '%': return binary(left.type, '%', left, right);
            case '===':
            case '==':
            case '!==':
            case '!=':
            case '<':
            case '<=':
            case '>':
            case '>=':
            case '&&':
            case '||':
                return binary(boolType(), op === '===' ? '==' : op === '!==' ? '!=' : op, left, right);
            case '&':
            case '|':
            case '^':
            case '<<':
            case '>>':
                return binary(left.type, op, left, right);
            default:
                throw this.error(`unsupported operator '${op}'`);
        }
    }

    private parseUnary(): unknown {
        if (this.peekPunc('-')) {
            this.next();
            return intrinsic('neg', [this.exprOf(this.parseUnary())]);
        }
        if (this.peekPunc('!')) {
            this.next();
            return unary(boolType(), '!', this.exprOf(this.parseUnary()));
        }
        if (this.peekPunc('+')) { this.next(); return this.parseUnary(); }
        if (this.peekPunc('++') || this.peekPunc('--')) {
            const op = this.next().value;
            return this.increment(this.exprOf(this.parseUnary()), op === '++');
        }
        return this.parsePostfix();
    }

    private parsePostfix(): unknown {
        let value: unknown = this.parsePrimary();
        for (;;) {
            if (this.peekPunc('.')) {
                this.next();
                const name = this.next();
                if (name.kind !== 'ident') throw this.error('expected a member name', name);
                value = this.member(value, name.value);
            } else if (this.peekPunc('[')) {
                this.next();
                const index = this.parseExpression();
                this.expectPunc(']');
                const base = this.exprOf(value);
                value = access(elementType(base.type), base, this.exprOf(index));
            } else if (this.peekPunc('(')) {
                value = this.callValue(value);
            } else if (this.peekPunc('++') || this.peekPunc('--')) {
                const op = this.next().value;
                value = this.increment(this.exprOf(value), op === '++');
            } else {
                break;
            }
        }
        return value;
    }

    /** `x++`/`x--` as an assignment statement targeting `x`. */
    private increment(target: IrExpr, up: boolean): IrStmt {
        const one = literal(target.type, 1);
        return assignStmt(target, up ? intrinsic('add', [target, one]) : intrinsic('sub', [target, one]));
    }

    private parsePrimary(): unknown {
        const token = this.next();
        if (token.kind === 'num') {
            const isInteger = !/[.eE]/.test(token.value);
            return literal(isInteger ? i32Type() : f32Type(), parseFloat(token.value));
        }
        if (token.kind === 'punc' && token.value === '(') {
            const inner = this.parseExpression();
            this.expectPunc(')');
            return inner;
        }
        if (token.kind === 'punc' && token.value === '{') {
            return this.parseObjectLiteral();
        }
        if (token.kind === 'ident') {
            if (token.value === 'true') return literal(boolType(), true);
            if (token.value === 'false') return literal(boolType(), false);
            const known = this.locals[token.value];
            if (known) return known;
            if (token.value === 'd' || /^d\d+$/.test(token.value)) return { __namespace: 'd' };
            if (token.value === 'std' || /^std\d+$/.test(token.value)) return { __namespace: 'std' };
            if (token.value === this.namespaceParams || token.value === this.namespaceMaterial || token.value === this.namespaceStd) {
                return { __namespace: token.value };
            }
            const destructured = this.destructured[token.value];
            if (destructured) {
                if (destructured === 'params') {
                    const value = this.params[this.destructuredKey[token.value] ?? token.value];
                    if (!value) throw this.error(`unknown input '${token.value}'`, token);
                    return value;
                }
                if (destructured === 'material') {
                    const value = this.material[this.destructuredKey[token.value] ?? token.value];
                    if (value !== undefined) return value;
                    // Otherwise fall through: the name may be a helper external.
                } else {
                    return this.member({ __namespace: 'std' }, token.value);
                }
            }
            const external = this.options.externals?.[token.value];
            if (external !== undefined) return external;
            const recovered = this.recoverExternal(token.value);
            if (recovered !== undefined) return recovered;
            throw this.error(`unknown identifier '${token.value}'`, token);
        }
        throw this.error('unexpected token', token);
    }

    /**
     * Recover a bundler-renamed external. A bundler renames colliding free
     * variables (for example `std` becomes `std2`), but the external object
     * still exposes the same members. This matches the member path that follows
     * the identifier against the registered externals, so `std2.sin` resolves
     * to `std` and `meshLayout2.$.uniforms` resolves to `meshLayout`.
     */
    private recoverExternal(name: string): unknown {
        // Bundlers rename colliding free variables (for example `std` becomes
        // `std2` or a short generated name). The `d`/`std` namespaces are always
        // available to a body, so include them in the candidates alongside the
        // registered externals.
        const externals = this.options.externals;
        const candidates: Record<string, unknown> = {
            d: externals?.d ?? dLib,
            std: externals?.std ?? stdLib,
            ...(externals ?? {}),
        };
        // A bundler renames colliding free variables by appending a counter
        // (`counts` becomes `counts2`). Stripping the suffix recovers the name.
        const stripped = name.replace(/[0-9]+$/, '');
        if (stripped && stripped !== name && candidates[stripped] !== undefined) return candidates[stripped];
        if (candidates[name] !== undefined) return candidates[name];
        const path: string[] = [];
        let i = this.pos;
        for (;;) {
            if (this.tokens[i]?.kind === 'punc' && this.tokens[i]!.value === '.'
                && this.tokens[i + 1]?.kind === 'ident') {
                path.push(this.tokens[i + 1]!.value);
                i += 2;
                continue;
            }
            if (this.tokens[i]?.kind === 'punc' && this.tokens[i]!.value === '[') {
                let depth = 0;
                while (i < this.tokens.length) {
                    const t = this.tokens[i]!;
                    if (t.kind === 'punc' && t.value === '[') depth += 1;
                    else if (t.kind === 'punc' && t.value === ']') {
                        depth -= 1;
                        if (depth === 0) { i += 1; break; }
                    }
                    i += 1;
                }
                path.push('[]');
                continue;
            }
            break;
        }
        if (path.length === 0) return undefined;
        // Bare-helper path: `renamedNs.lightContribution` where the helper is a
        // flat external (`externals.lightContribution`), not a namespace member.
        if (path.length === 1 && candidates[path[0]!] !== undefined) return { [path[0]!]: candidates[path[0]!] };
        for (const key of Object.keys(candidates)) {
            let value: unknown = candidates[key];
            let ok = true;
            for (const step of path) {
                const next = memberNext(value, step);
                if (!next.ok) { ok = false; break; }
                value = next.value;
            }
            if (ok && value !== undefined) return candidates[key];
        }
        return undefined;
    }

    /**
     * Parse an object literal in expression position. The leading `{` has
     * already been consumed by {@link parsePrimary}. Engine vertex bodies return
     * one of these to produce their varying outputs.
     */
    private parseObjectLiteral(): { __object: Array<{ key: string; value: IrExpr }> } {
        const entries: Array<{ key: string; value: IrExpr }> = [];
        while (!this.peekPunc('}')) {
            const key = this.next();
            if (key.kind !== 'ident') throw this.error('expected an object key', key);
            this.expectPunc(':');
            entries.push({ key: key.value, value: this.exprOf(this.parseExpression()) });
            if (this.peekPunc(',')) this.next();
        }
        this.expectPunc('}');
        return { __object: entries };
    }

    private member(base: unknown, name: string): unknown {
        if (isNamespace(base)) {
            if (base.__namespace === this.namespaceParams) {
                const value = this.params[name];
                if (!value) throw this.error(`unknown input '${name}'`);
                return value;
            }
            if (base.__namespace === this.namespaceMaterial) {
                const value = this.material[name];
                if (!value) throw this.error(`unknown material field '${name}'`);
                return value;
            }
            // d namespace: a scalar cast such as d.u32(x), or a constructor
            // such as d.vec3f(...) when a `d` object is registered as an external.
            if (base.__namespace === 'd') {
                // Prefer a backend-supplied namespace when present (it may be a
                // superset with extra constructors); otherwise the DSL's own.
                const dns = (this.options.externals?.d ?? dLib) as Record<string, unknown>;
                const constructor = dns[name];
                if (typeof constructor === 'function') return constructor;
                return { __cast: name };
            }
            // std namespace: prefer the backend's own namespace so its overrides
            // apply; otherwise the DSL's. Fall back to a name-only intrinsic.
            const stdNs = (this.options.externals?.std ?? stdLib) as Record<string, unknown>;
            const member = stdNs[name];
            if (typeof member === 'function') return member;
            return { __intrinsic: name };
        }
        // External object member access (for example a layout's `.$.uniforms`).
        if (isObject(base) && !isExprLike(base)) {
            const value = (base as Record<string, unknown>)[name];
            if (value !== undefined) return value;
        }
        const expr = this.exprOf(base);
        if (expr.type.kind === 'mat' && name === 'columns') {
            const column = { kind: 'vec', scalar: expr.type.scalar, width: expr.type.rows } as GpuType;
            const array = { kind: 'array', element: column, count: expr.type.cols } as GpuType;
            return access(array, expr, 'columns');
        }
        if (expr.type.kind === 'vec' && SWIZZLE.test(name)) return swizzle(expr, name);
        return access(fieldType(expr.type, name), expr, name);
    }

    private callValue(callee: unknown): unknown {
        this.expectPunc('(');
        const args: IrExpr[] = [];
        while (!this.peekPunc(')')) {
            args.push(this.exprOf(this.parseExpression()));
            if (this.peekPunc(',')) this.next();
        }
        this.expectPunc(')');
        if (isNamespace(callee)) throw this.error('a namespace is not callable');
        if (isCast(callee)) {
            if (args.length !== 1) throw this.error(`cast '${callee.__cast}' takes one argument`);
            const type = castType(callee.__cast);
            if (!type) throw this.error(`unknown cast 'd.${callee.__cast}'`);
            return cast(type, args[0]!);
        }
        if (isIntrinsic(callee)) return intrinsic(callee.__intrinsic, args);
        if (typeof callee === 'function') return (callee as (...a: IrExpr[]) => unknown)(...args);
        throw this.error('only std/d namespace calls and external functions are supported');
    }

    // --- helpers -----------------------------------------------------------

    private exprOf(value: unknown): IrExpr {
        if (value instanceof ShaderValue) return value.node;
        if (isExprLike(value)) return value as IrExpr;
        if (isStmtNode(value)) throw this.error('a statement cannot be used as a value');
        throw this.error('expected an expression');
    }

    private startsBlock(): boolean { return this.peekPunc('{'); }
    private peek(): Token { return this.tokens[this.pos]!; }
    private peekKind(kind: Token['kind']): boolean { return this.peek().kind === kind; }
    private peekPunc(value: string): boolean { const t = this.peek(); return t.kind === 'punc' && t.value === value; }
    private peekPuncIn(values: readonly string[]): boolean { const t = this.peek(); return t.kind === 'punc' && values.includes(t.value); }
    private next(): Token { return this.tokens[this.pos++]!; }
    private expectPunc(value: string): void {
        const t = this.next();
        if (t.kind !== 'punc' || t.value !== value) throw this.error(`expected '${value}'`, t);
    }
    private consumeSemicolon(): void { if (this.peekPunc(';')) this.next(); }
    private error(message: string, token?: Token): Error {
        const idx = token ? this.tokens.indexOf(token) : this.pos;
        const around = this.tokens.slice(Math.max(0, idx - 30), idx + 20).map((t) => (t === token ? `>>${t.value}<<` : t.value)).join(' ');
        return new Error(`${message}${token ? ` (at ${token.start})` : ''} :: ${around}`);
    }
}

// --- module helpers --------------------------------------------------------

function buildSchemas(
    options: ParseShaderOptions,
    params: Record<string, ShaderValue>,
    material: Record<string, ShaderValue | Record<string, ShaderValue>>,
): void {
    for (const name of Object.keys(options.params ?? {})) {
        params[name] = new ShaderValue({ node: builtin((options.params as Record<string, GpuType>)[name]!, name) });
    }
    for (const name of Object.keys(options.builtins ?? {})) {
        const spelling = options.builtinNames?.[name] ?? name;
        params[name] = new ShaderValue({ node: builtin((options.builtins as Record<string, GpuType>)[name]!, spelling) });
    }
    let index = 0;
    for (const name of Object.keys(options.material ?? {})) {
        material[name] = new ShaderValue({ node: binding((options.material as Record<string, GpuType>)[name]!, 0, index++) });
    }
    for (const name of Object.keys(options.bindings ?? {})) {
        const value = options.bindings![name] as
            | { group: number; slots: readonly { name: string; binding: number; type: GpuType; readwrite: boolean }[] }
            | ShaderValue
            | Record<string, ShaderValue>;
        if (value && typeof value === 'object' && Array.isArray((value as { slots?: unknown }).slots)) {
            const layout = value as { group: number; slots: readonly { name: string; binding: number; type: GpuType; readwrite: boolean }[] };
            const view: Record<string, ShaderValue> = {};
            for (const slot of layout.slots) {
                const node = binding(slot.type, layout.group, slot.binding);
                if (slot.readwrite) (node as { access?: string }).access = 'read_write';
                view[slot.name] = new ShaderValue({ node });
            }
            material[name] = view;
        } else {
            material[name] = value as ShaderValue | Record<string, ShaderValue>;
        }
    }
}

function intrinsic(name: string, args: IrExpr[]): IrExpr {
    const fn = (stdLib as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    if (typeof fn !== 'function') throw new Error(`parseShader: unknown intrinsic 'std.${name}'`);
    return exprResult(fn(...args));
}

function exprResult(value: unknown): IrExpr {
    if (value instanceof ShaderValue) return value.node;
    return value as IrExpr;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

interface MemberStep {
    readonly ok: boolean;
    readonly value?: unknown;
}

/** One step of a renamed-external member path, understanding struct types. */
function memberNext(value: unknown, step: string): MemberStep {
    if (typeof value !== 'object' || value === null) return { ok: false };
    if (step in (value as object)) return { ok: true, value: (value as Record<string, unknown>)[step] };
    const type = (value as { type?: GpuType }).type
        ?? (value as { node?: { type?: GpuType } }).node?.type;
    if (type && type.kind === 'struct') {
        const field = type.fields.find((f) => f.name === step);
        if (field) return { ok: true, value: { type: field.type } };
    }
    if (step === '[]' && type && type.kind === 'array') {
        return { ok: true, value: { type: type.element } };
    }
    if (type && type.kind === 'vec') {
        const components: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
        const indices = step.split('').map((c) => components[c]);
        if (indices.length > 0 && indices.every((n) => n !== undefined)) {
            const width = indices.length;
            const swizzled = width === 1
                ? { kind: 'scalar', scalar: type.scalar } as GpuType
                : { kind: 'vec', scalar: type.scalar, width } as GpuType;
            return { ok: true, value: { type: swizzled } };
        }
    }
    return { ok: false };
}

function isObjectLiteral(value: unknown): value is { __object: Array<{ key: string; value: IrExpr }> } {
    return isObject(value) && Array.isArray((value as { __object?: unknown }).__object);
}

function isExprLike(value: unknown): boolean {
    return typeof value === 'object' && value !== null && 'kind' in (value as object) && !isStmtNode(value);
}

function isStmtNode(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const kind = (value as { kind?: string }).kind;
    return kind === 'let' || kind === 'assign' || kind === 'if' || kind === 'loop'
        || kind === 'return' || kind === 'discard' || kind === 'break' || kind === 'continue';
}

function isNamespace(value: unknown): value is { __namespace: string } {
    return typeof value === 'object' && value !== null && '__namespace' in value;
}

function isIntrinsic(value: unknown): value is { __intrinsic: string } {
    return typeof value === 'object' && value !== null && '__intrinsic' in value;
}

function isCast(value: unknown): value is { __cast: string } {
    return typeof value === 'object' && value !== null && '__cast' in value;
}

function castType(name: string): GpuType | null {
    switch (name) {
        case 'f32': return f32Type();
        case 'i32': return i32Type();
        case 'u32': return u32Type();
        case 'bool': return boolType();
        default: return null;
    }
}

function notExpr(cond: IrExpr): IrExpr {
    return unary(boolType(), '!', cond);
}

/**
 * Body of a `for`/`while` loop: break when the condition fails, then the user
 * statements, then the update statements.
 */
function loopBody(cond: IrExpr | null, body: readonly IrStmt[], update: readonly IrStmt[]): IrStmt[] {
    const stmts: IrStmt[] = [];
    if (cond) stmts.push(ifStmt(notExpr(cond), [breakStmt()], null));
    stmts.push(...body, ...update);
    return stmts;
}

/** Tail of a `do`/`while` loop: break after the body when the condition fails. */
function loopTail(cond: IrExpr): IrStmt[] {
    return [ifStmt(notExpr(cond), [breakStmt()], null)];
}

function exprType(expr: IrExpr): GpuType { return expr.type; }

function elementType(type: GpuType): GpuType {
    if (type.kind === 'array') return type.element;
    return type;
}

function vectorWidth(type: GpuType): number {
    if (type.kind === 'vec') return type.width;
    return 1;
}

function fieldType(type: GpuType, name: string): GpuType {
    if (type.kind === 'struct') {
        const field = type.fields.find((f) => f.name === name);
        if (field) return field.type;
    }
    throw new Error(`parseShader: '${name}' is not a field of ${describeType(type)}`);
}

/** Target-neutral label for a type, used in diagnostics. */
function describeType(type: GpuType): string {
    switch (type.kind) {
        case 'scalar':
            return type.scalar;
        case 'vec':
            return `vec of ${type.width} by ${type.scalar}`;
        case 'mat':
            return `mat of ${type.cols} by ${type.rows} ${type.scalar}`;
        case 'array':
            return `array of ${describeType(type.element)}`;
        case 'struct':
            return `struct ${type.name}`;
        case 'texture':
            return `${type.dim} texture`;
        case 'sampler':
            return 'sampler';
    }
}

export { toExpr };

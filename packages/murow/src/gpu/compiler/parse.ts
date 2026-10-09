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
    wgslType,
} from '../ir/types';
import {
    access,
    assignStmt,
    binary,
    breakStmt,
    builtin,
    call,
    cast,
    continueStmt,
    discardStmt,
    entry,
    ifStmt,
    letStmt,
    literal,
    local,
    loopStmt,
    param,
    returnStmt,
    swizzle,
    unary,
    type IrEntry,
    type IrExpr,
    type IrParam,
    type IrStmt,
    type IrStage,
} from '../ir';
import { ShaderValue, toExpr } from '../dsl/value';
import { std as stdLib } from '../dsl/std';
import { binding } from '../ir/builders';

/** Options describing the entry to build from parsed source. */
export interface ParseShaderOptions {
    readonly stage: IrStage;
    readonly params?: Record<string, GpuType>;
    readonly material?: Record<string, GpuType>;
    readonly workgroupSize?: readonly [number, number, number];
}

interface Token {
    readonly kind: 'num' | 'ident' | 'punc' | 'eof';
    readonly value: string;
    readonly start: number;
}

const PUNCTUATORS = [
    '=>', '==', '!=', '<=', '>=', '&&', '||', '++', '--',
    '{', '}', '(', ')', '[', ']', ';', ',', '.', ':', '?',
    '+', '-', '*', '/', '%', '<', '>', '=', '!',
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
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
            const start = i;
            while (i < source.length && /[0-9.]/.test(source[i]!)) i++;
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
    private readonly material: Record<string, ShaderValue> = Object.create(null);
    private namespaceParams = '';
    private namespaceMaterial = '';
    private namespaceStd = '';

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
        });
    }

    private parseArrowHeader(): void {
        // Accept `(a, b, c) =>`, `a =>`, or a plain `{ ... }` body.
        if (this.startsBlock()) return;
        const names: string[] = [];
        if (this.peekPunc('(')) {
            this.next();
            while (!this.peekPunc(')')) {
                const t = this.next();
                if (t.kind !== 'ident') throw this.error('expected a parameter name', t);
                names.push(t.value);
                if (this.peekPunc(',')) this.next();
            }
            this.expectPunc(')');
        } else if (this.peekKind('ident')) {
            names.push(this.next().value);
        }
        if (this.peekPunc('=>')) this.next();
        // Positional namespaces: params, material, std.
        this.namespaceParams = names[0] ?? 'v';
        this.namespaceMaterial = names[1] ?? 'm';
        this.namespaceStd = names[2] ?? 's';
    }

    private parseBlock(): IrStmt[] {
        this.expectPunc('{');
        const body: IrStmt[] = [];
        while (!this.peekPunc('}') && !this.peekKind('eof')) {
            for (const stmt of this.parseStatement()) body.push(stmt);
        }
        this.expectPunc('}');
        return body;
    }

    private parseStatement(): IrStmt[] {
        const token = this.peek();
        if (token.kind === 'ident') {
            if (token.value === 'const' || token.value === 'let' || token.value === 'var') return [this.parseVarDecl()];
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
        // Expression statement.
        const expr = this.parseExpression();
        this.consumeSemicolon();
        if (isStmtNode(expr)) return [expr as IrStmt];
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
                init.push(this.parseVarDecl());
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

    private parseVarDecl(): IrStmt {
        this.next();
        const name = this.next();
        if (name.kind !== 'ident') throw this.error('expected a variable name', name);
        this.expectPunc('=');
        const value = this.parseExpression();
        this.consumeSemicolon();
        const id = this.nextLocal++;
        this.locals[name.value] = local(exprType(this.exprOf(value)), id);
        return letStmt(id, this.locals[name.value]!.type, this.exprOf(value));
    }

    private parseReturn(): IrStmt {
        this.next();
        if (this.peekPunc(';')) {
            this.next();
            return returnStmt(null);
        }
        const value = this.parseExpression();
        this.consumeSemicolon();
        return returnStmt(this.exprOf(value));
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
        ['==', '!='],
        ['<', '<=', '>', '>='],
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
            case '==':
            case '!=':
            case '<':
            case '<=':
            case '>':
            case '>=':
            case '&&':
            case '||':
                return binary(boolType(), op, left, right);
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
            } else {
                break;
            }
        }
        return value;
    }

    private parsePrimary(): unknown {
        const token = this.next();
        if (token.kind === 'num') return literal(f32Type(), parseFloat(token.value));
        if (token.kind === 'punc' && token.value === '(') {
            const inner = this.parseExpression();
            this.expectPunc(')');
            return inner;
        }
        if (token.kind === 'ident') {
            if (token.value === 'true') return literal(boolType(), true);
            if (token.value === 'false') return literal(boolType(), false);
            if (token.value === 'd') return { __namespace: 'd' };
            if (token.value === this.namespaceParams || token.value === this.namespaceMaterial || token.value === this.namespaceStd) {
                return { __namespace: token.value };
            }
            const known = this.locals[token.value];
            if (known) return known;
            throw this.error(`unknown identifier '${token.value}'`, token);
        }
        throw this.error('unexpected token', token);
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
            // d namespace: a scalar cast such as d.u32(x).
            if (base.__namespace === 'd') return { __cast: name };
            // std namespace: a callable intrinsic.
            return { __intrinsic: name };
        }
        const expr = this.exprOf(base);
        if (SWIZZLE.test(name)) return swizzle(expr, name);
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
        throw this.error('only std/d namespace calls are supported');
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
        return new Error(`${message}${token ? ` (at ${token.start})` : ''}`);
    }
}

// --- module helpers --------------------------------------------------------

function buildSchemas(
    options: ParseShaderOptions,
    params: Record<string, ShaderValue>,
    material: Record<string, ShaderValue>,
): void {
    for (const name of Object.keys(options.params ?? {})) {
        params[name] = new ShaderValue({ node: builtin((options.params as Record<string, GpuType>)[name]!, name) });
    }
    let index = 0;
    for (const name of Object.keys(options.material ?? {})) {
        material[name] = new ShaderValue({ node: binding((options.material as Record<string, GpuType>)[name]!, 0, index++) });
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
    throw new Error(`parseShader: '${name}' is not a field of ${wgslType(type)}`);
}

export { toExpr };

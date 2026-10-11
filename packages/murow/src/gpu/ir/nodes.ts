/**
 * The intermediate representation shaders compile to.
 *
 * Structured, typed, pure data. Backends emit WGSL or GLSL from this; the DSL
 * front-end (or the build-time transform) produces it. No backend specifics.
 */
import type { GpuType } from '../types';

/** Local temporary id, allocated by the front-end. */
export type IrId = number;

export interface IrLiteral {
    readonly kind: 'literal';
    readonly type: GpuType;
    readonly value: number | boolean | readonly number[];
}

/** Reference to a local temporary. */
export interface IrLocal {
    readonly kind: 'local';
    readonly type: GpuType;
    readonly id: IrId;
}

/** A bound resource (uniform, storage, texture, sampler). */
export interface IrBinding {
    readonly kind: 'binding';
    readonly type: GpuType;
    readonly group: number;
    readonly binding: number;
}

/** A stage builtin (position, frag coord, front facing, invocation id, ...). */
export interface IrBuiltin {
    readonly kind: 'builtin';
    readonly type: GpuType;
    readonly name: string;
}

export interface IrUnary {
    readonly kind: 'unary';
    readonly type: GpuType;
    readonly op: string;
    readonly value: IrExpr;
}

export interface IrBinary {
    readonly kind: 'binary';
    readonly type: GpuType;
    readonly op: string;
    readonly left: IrExpr;
    readonly right: IrExpr;
}

export interface IrConstruct {
    readonly kind: 'construct';
    readonly type: GpuType;
    readonly args: readonly IrExpr[];
}

export interface IrSwizzle {
    readonly kind: 'swizzle';
    readonly type: GpuType;
    readonly value: IrExpr;
    readonly mask: string;
}

/** Member access (`index` is a field name) or array/index access (numeric). */
export interface IrAccess {
    readonly kind: 'access';
    readonly type: GpuType;
    readonly value: IrExpr;
    readonly index: IrExpr | string;
}

export interface IrCall {
    readonly kind: 'call';
    readonly type: GpuType;
    readonly name: string;
    readonly args: readonly IrExpr[];
}

export interface IrSample {
    readonly kind: 'sample';
    readonly type: GpuType;
    readonly texture: IrExpr;
    readonly sampler: IrExpr;
    readonly coords: IrExpr;
}

/** A numeric/type conversion, e.g. `u32(x)` or `f32(i)`. */
export interface IrCast {
    readonly kind: 'cast';
    readonly type: GpuType;
    readonly value: IrExpr;
}

export type IrExpr =
    | IrLiteral
    | IrLocal
    | IrBinding
    | IrBuiltin
    | IrUnary
    | IrBinary
    | IrConstruct
    | IrSwizzle
    | IrAccess
    | IrCall
    | IrSample
    | IrCast;

export interface IrLet {
    readonly kind: 'let';
    readonly id: IrId;
    readonly type: GpuType;
    readonly value: IrExpr;
}

export interface IrAssign {
    readonly kind: 'assign';
    readonly target: IrExpr;
    readonly value: IrExpr;
}

export interface IrIf {
    readonly kind: 'if';
    readonly cond: IrExpr;
    readonly then: readonly IrStmt[];
    readonly otherwise: readonly IrStmt[] | null;
}

export interface IrLoop {
    readonly kind: 'loop';
    readonly body: readonly IrStmt[];
}

export interface IrReturn {
    readonly kind: 'return';
    readonly value: IrExpr | null;
}

export interface IrDiscard {
    readonly kind: 'discard';
}

export interface IrBreak {
    readonly kind: 'break';
}

export interface IrContinue {
    readonly kind: 'continue';
}

export type IrStmt =
    | IrLet
    | IrAssign
    | IrIf
    | IrLoop
    | IrReturn
    | IrDiscard
    | IrBreak
    | IrContinue;

export type IrStage = 'vertex' | 'fragment' | 'compute';

export interface IrParam {
    readonly name: string;
    readonly type: GpuType;
    readonly location: number;
}

/**
 * One field of a vertex output struct. Exactly one of `builtin` or `location`
 * is set: `builtin` names a stage builtin (for example `position`), `location`
 * is the varying slot.
 */
export interface IrOutput {
    readonly name: string;
    readonly type: GpuType;
    readonly builtin?: string;
    readonly location?: number;
}

/** A compiled entry point: a stage, its inputs, outputs, and its body. */
export interface IrEntry {
    readonly stage: IrStage;
    readonly params: readonly IrParam[];
    readonly body: readonly IrStmt[];
    readonly workgroupSize?: readonly [number, number, number];
    readonly outputs?: readonly IrOutput[];
}

export function isExpr(node: IrExpr | IrStmt): node is IrExpr {
    switch (node.kind) {
        case 'literal':
        case 'local':
        case 'binding':
        case 'builtin':
        case 'unary':
        case 'binary':
        case 'construct':
        case 'swizzle':
        case 'access':
        case 'call':
        case 'sample':
        case 'cast':
            return true;
        default:
            return false;
    }
}

export function isStmt(node: IrExpr | IrStmt): node is IrStmt {
    return !isExpr(node);
}

/** A terminator ends a block: `return`, `discard`, `break`, or `continue`. */
export function isTerminator(
    node: IrExpr | IrStmt,
): node is IrReturn | IrDiscard | IrBreak | IrContinue {
    return node.kind === 'return'
        || node.kind === 'discard'
        || node.kind === 'break'
        || node.kind === 'continue';
}

/** A leaf value reference: literal, local, binding, or builtin. */
export function isValue(
    node: IrExpr | IrStmt,
): node is IrLiteral | IrLocal | IrBinding | IrBuiltin {
    switch (node.kind) {
        case 'literal':
        case 'local':
        case 'binding':
        case 'builtin':
            return true;
        default:
            return false;
    }
}

function walkExpr(expr: IrExpr, visit: (node: IrExpr | IrStmt) => void): void {
    visit(expr);
    switch (expr.kind) {
        case 'unary':
            walkExpr(expr.value, visit);
            break;
        case 'binary':
            walkExpr(expr.left, visit);
            walkExpr(expr.right, visit);
            break;
        case 'construct':
            for (const arg of expr.args) walkExpr(arg, visit);
            break;
        case 'swizzle':
            walkExpr(expr.value, visit);
            break;
        case 'access':
            walkExpr(expr.value, visit);
            if (typeof expr.index !== 'string') walkExpr(expr.index, visit);
            break;
        case 'call':
            for (const arg of expr.args) walkExpr(arg, visit);
            break;
        case 'sample':
            walkExpr(expr.texture, visit);
            walkExpr(expr.sampler, visit);
            walkExpr(expr.coords, visit);
            break;
        case 'cast':
            walkExpr(expr.value, visit);
            break;
        default:
            break;
    }
}

function walkStmt(stmt: IrStmt, visit: (node: IrExpr | IrStmt) => void): void {
    visit(stmt);
    switch (stmt.kind) {
        case 'let':
            walkExpr(stmt.value, visit);
            break;
        case 'assign':
            walkExpr(stmt.target, visit);
            walkExpr(stmt.value, visit);
            break;
        case 'if':
            walkExpr(stmt.cond, visit);
            for (const s of stmt.then) walkStmt(s, visit);
            if (stmt.otherwise) for (const s of stmt.otherwise) walkStmt(s, visit);
            break;
        case 'loop':
            for (const s of stmt.body) walkStmt(s, visit);
            break;
        case 'return':
            if (stmt.value) walkExpr(stmt.value, visit);
            break;
        default:
            break;
    }
}

/** Visit every node in an entry point in pre-order. */
export function walkEntry(entry: IrEntry, visit: (node: IrExpr | IrStmt) => void): void {
    for (const stmt of entry.body) walkStmt(stmt, visit);
}

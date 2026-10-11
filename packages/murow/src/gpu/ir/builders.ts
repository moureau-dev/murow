/**
 * Pure factory helpers for IR nodes.
 *
 * Named parameters only where a node has more than one field. Every helper
 * returns a fresh, frozen-by-convention node; inputs are never mutated.
 */
import type {
    IrAccess,
    IrAssign,
    IrBinary,
    IrBinding,
    IrBreak,
    IrBuiltin,
    IrCall,
    IrCast,
    IrConstruct,
    IrContinue,
    IrDiscard,
    IrEntry,
    IrExpr,
    IrId,
    IrIf,
    IrLet,
    IrLiteral,
    IrLocal,
    IrLoop,
    IrOutput,
    IrParam,
    IrReturn,
    IrSample,
    IrStage,
    IrStmt,
    IrSwizzle,
    IrUnary,
} from './nodes';
import type { GpuType } from './types';
import { swizzleType } from './types';

export interface EntryOptions {
    readonly stage: IrStage;
    readonly params: readonly IrParam[];
    readonly body: readonly IrStmt[];
    readonly workgroupSize?: readonly [number, number, number];
    readonly outputs?: readonly IrOutput[];
}

/** Constant literal. */
export function literal(type: GpuType, value: IrLiteral['value']): IrLiteral {
    return { kind: 'literal', type, value };
}

/** Reference to a local temporary. */
export function local(type: GpuType, id: IrId): IrLocal {
    return { kind: 'local', type, id };
}

/** Bound resource reference. */
export function binding(type: GpuType, group: number, binding: number): IrBinding {
    return { kind: 'binding', type, group, binding };
}

/** Stage builtin reference. */
export function builtin(type: GpuType, name: string): IrBuiltin {
    return { kind: 'builtin', type, name };
}

/** Unary operation. */
export function unary(type: GpuType, op: string, value: IrExpr): IrUnary {
    return { kind: 'unary', type, op, value };
}

/** Binary operation. */
export function binary(type: GpuType, op: string, left: IrExpr, right: IrExpr): IrBinary {
    return { kind: 'binary', type, op, left, right };
}

/** Constructor call such as `vec4f(...)`. */
export function construct(type: GpuType, args: readonly IrExpr[]): IrConstruct {
    return { kind: 'construct', type, args: [...args] };
}

/** Component swizzle. The result type is derived from the input and mask. */
export function swizzle(value: IrExpr, mask: string): IrSwizzle {
    return {
        kind: 'swizzle',
        type: swizzleType(value.type, mask),
        value,
        mask,
    };
}

/** Member access (string index) or array/index access (expression index). */
export function access(type: GpuType, value: IrExpr, index: IrExpr | string): IrAccess {
    return { kind: 'access', type, value, index };
}

/** Free function or intrinsic call. */
export function call(type: GpuType, name: string, args: readonly IrExpr[]): IrCall {
    return { kind: 'call', type, name, args: [...args] };
}

/** Texture sample. */
export function sample(
    type: GpuType,
    texture: IrExpr,
    sampler: IrExpr,
    coords: IrExpr,
): IrSample {
    return { kind: 'sample', type, texture, sampler, coords };
}

/** `let` binding statement. */
export function letStmt(id: IrId, type: GpuType, value: IrExpr): IrLet {
    return { kind: 'let', id, type, value };
}

/** Assignment to a mutable target. */
export function assignStmt(target: IrExpr, value: IrExpr): IrAssign {
    return { kind: 'assign', target, value };
}

/** Conditional statement. */
export function ifStmt(
    cond: IrExpr,
    then: readonly IrStmt[],
    otherwise: readonly IrStmt[] | null = null,
): IrIf {
    return { kind: 'if', cond, then: [...then], otherwise: otherwise ? [...otherwise] : null };
}

/** Loop statement. */
export function loopStmt(body: readonly IrStmt[]): IrLoop {
    return { kind: 'loop', body: [...body] };
}

/** Return statement. */
export function returnStmt(value: IrExpr | null = null): IrReturn {
    return { kind: 'return', value };
}

/** Discard statement (fragment stage only). */
export function discardStmt(): IrDiscard {
    return { kind: 'discard' };
}

/** Break out of the enclosing loop. */
export function breakStmt(): IrBreak {
    return { kind: 'break' };
}

/** Continue the enclosing loop. */
export function continueStmt(): IrContinue {
    return { kind: 'continue' };
}

/** Numeric/type conversion, e.g. `u32(x)` or `f32(i)`. */
export function cast(type: GpuType, value: IrExpr): IrCast {
    return { kind: 'cast', type, value };
}

/** Entry point parameter. */
export function param(name: string, type: GpuType, location: number): IrParam {
    return { name, type, location };
}

/** Vertex output field, bound to a builtin or a location. */
export function output(
    name: string,
    type: GpuType,
    opts: { builtin?: string; location?: number },
): IrOutput {
    return {
        name,
        type,
        ...(opts.builtin !== undefined ? { builtin: opts.builtin } : {}),
        ...(opts.location !== undefined ? { location: opts.location } : {}),
    };
}

/** Entry point. */
export function entry(options: EntryOptions): IrEntry {
    return {
        stage: options.stage,
        params: [...options.params],
        body: [...options.body],
        ...(options.workgroupSize ? { workgroupSize: options.workgroupSize } : {}),
        ...(options.outputs ? { outputs: [...options.outputs] } : {}),
    };
}

/**
 * Structured control flow.
 *
 * Builds `if`, `loop`, and `select` IR. No back edges: iteration uses `loop`.
 *
 * Pure. No backend, no device.
 */
import type { IrIf, IrLoop, IrStmt } from '../ir/nodes';
import { call, ifStmt, loopStmt } from '../ir/builders';
import { combineType, ShaderValue, toExpr, type ShaderInput } from './value';

/** A statement or a list of statements. */
export type Body = IrStmt | readonly IrStmt[];

function flatten(body: Body): IrStmt[] {
    return Array.isArray(body) ? (body as IrStmt[]).slice() : [body as IrStmt];
}

/** Conditional branch. */
export function branch(cond: ShaderInput, thenBody: Body, elseBody?: Body): IrIf {
    return ifStmt(toExpr(cond), flatten(thenBody), elseBody === undefined ? null : flatten(elseBody));
}

/** Loop. */
export function loop(body: Body): IrLoop {
    return loopStmt(flatten(body));
}

/** Component-wise select: `cond` picks `b` when true, `a` when false. */
export function select(cond: ShaderInput, a: ShaderInput, b: ShaderInput): ShaderValue {
    const left = toExpr(a);
    const right = toExpr(b);
    return new ShaderValue({
        node: call(combineType(left.type, right.type), 'select', [left, right, toExpr(cond)]),
    });
}

/** Collect statements into a body block. */
export function body(...stmts: readonly Body[]): IrStmt[] {
    const out: IrStmt[] = [];
    for (const stmt of stmts) out.push(...flatten(stmt));
    return out;
}

/**
 * The ordered lowering pipeline.
 *
 * Shared passes run first, then backend passes. Every pass is a pure function
 * from one entry to a new entry; inputs are never mutated.
 */
import type {
    IrEntry,
    IrExpr,
    IrLiteral,
    IrStmt,
} from '../ir/nodes';
import { walkEntry } from '../ir/nodes';
import type { GpuType } from '../types';
import { literal } from '../ir/builders';

/** One lowering step. */
export interface LoweringPass {
    readonly name: string;
    run(entry: IrEntry): IrEntry;
}

/** Options for {@link PassPipeline}. */
export interface PassPipelineOptions {
    readonly shared?: readonly LoweringPass[];
    readonly backend?: readonly LoweringPass[];
}

/**
 * Runs shared passes then backend passes, in order, over an entry.
 */
export class PassPipeline {
    readonly shared: readonly LoweringPass[];
    readonly backend: readonly LoweringPass[];

    constructor(options: PassPipelineOptions = {}) {
        this.shared = options.shared ?? [];
        this.backend = options.backend ?? [];
    }

    /** Shared followed by backend passes. */
    get passes(): readonly LoweringPass[] {
        return [...this.shared, ...this.backend];
    }

    /** Lower an entry through every pass. */
    run(entry: IrEntry): IrEntry {
        let current = entry;
        for (const pass of this.passes) current = pass.run(current);
        return current;
    }
}

/** Fold binary and unary operations on scalar literals. */
export const constantFoldPass: LoweringPass = {
    name: 'constant-fold',
    run(entry: IrEntry): IrEntry {
        return { ...entry, body: entry.body.map(foldStmt) };
    },
};

/** Drop `let` bindings that are never referenced and have a pure value. */
export const deadLetPass: LoweringPass = {
    name: 'dead-let',
    run(entry: IrEntry): IrEntry {
        const used = collectUsedIds(entry);
        return { ...entry, body: eliminateStmts(entry.body, used) };
    },
};

/** The passes every backend runs before its own. */
export const SHARED_PASSES: readonly LoweringPass[] = [constantFoldPass, deadLetPass];

function foldStmt(stmt: IrStmt): IrStmt {
    switch (stmt.kind) {
        case 'let':
            return { ...stmt, value: foldExpr(stmt.value) };
        case 'assign':
            return { ...stmt, target: foldExpr(stmt.target), value: foldExpr(stmt.value) };
        case 'if':
            return {
                ...stmt,
                cond: foldExpr(stmt.cond),
                then: stmt.then.map(foldStmt),
                otherwise: stmt.otherwise ? stmt.otherwise.map(foldStmt) : null,
            };
        case 'loop':
            return { ...stmt, body: stmt.body.map(foldStmt) };
        case 'return':
            return { ...stmt, value: stmt.value ? foldExpr(stmt.value) : null };
        default:
            return stmt;
    }
}

function foldExpr(expr: IrExpr): IrExpr {
    switch (expr.kind) {
        case 'binary': {
            const left = foldExpr(expr.left);
            const right = foldExpr(expr.right);
            const folded = foldBinary(expr.type, expr.op, left, right);
            return folded ?? { ...expr, left, right };
        }
        case 'unary': {
            const value = foldExpr(expr.value);
            const folded = foldUnary(expr.type, expr.op, value);
            return folded ?? { ...expr, value };
        }
        case 'construct':
            return { ...expr, args: expr.args.map(foldExpr) };
        case 'swizzle':
            return { ...expr, value: foldExpr(expr.value) };
        case 'access':
            return {
                ...expr,
                value: foldExpr(expr.value),
                index: typeof expr.index === 'string' ? expr.index : foldExpr(expr.index),
            };
        case 'call':
            return { ...expr, args: expr.args.map(foldExpr) };
        case 'sample':
            return {
                ...expr,
                texture: foldExpr(expr.texture),
                sampler: foldExpr(expr.sampler),
                coords: foldExpr(expr.coords),
            };
        default:
            return expr;
    }
}

function foldBinary(type: GpuType, op: string, left: IrExpr, right: IrExpr): IrLiteral | null {
    if (left.kind !== 'literal' || right.kind !== 'literal') return null;
    if (left.type.kind !== 'scalar' || right.type.kind !== 'scalar') return null;

    if (typeof left.value === 'boolean' || typeof right.value === 'boolean') {
        if (typeof left.value !== 'boolean' || typeof right.value !== 'boolean') return null;
        switch (op) {
            case '==':
                return literal(type, left.value === right.value);
            case '!=':
                return literal(type, left.value !== right.value);
            case '&&':
                return literal(type, left.value && right.value);
            case '||':
                return literal(type, left.value || right.value);
            default:
                return null;
        }
    }

    const a = left.value as number;
    const b = right.value as number;
    switch (op) {
        case '+':
            return literal(type, a + b);
        case '-':
            return literal(type, a - b);
        case '*':
            return literal(type, a * b);
        case '/':
            return b === 0 ? null : literal(type, a / b);
        case '%':
            return b === 0 ? null : literal(type, a % b);
        case '==':
            return literal(type, a === b);
        case '!=':
            return literal(type, a !== b);
        case '<':
            return literal(type, a < b);
        case '<=':
            return literal(type, a <= b);
        case '>':
            return literal(type, a > b);
        case '>=':
            return literal(type, a >= b);
        default:
            return null;
    }
}

function foldUnary(type: GpuType, op: string, value: IrExpr): IrLiteral | null {
    if (value.kind !== 'literal' || value.type.kind !== 'scalar') return null;
    if (typeof value.value === 'boolean') {
        return op === '!' ? literal(type, !value.value) : null;
    }
    if (typeof value.value !== 'number') return null;
    if (op === '-') return literal(type, -value.value);
    if (op === '+') return literal(type, value.value);
    return null;
}

function collectUsedIds(entry: IrEntry): boolean[] {
    const used: boolean[] = [];
    walkEntry(entry, (node) => {
        if (node.kind === 'local') used[node.id] = true;
    });
    return used;
}

function eliminateStmts(stmts: readonly IrStmt[], used: boolean[]): IrStmt[] {
    const out: IrStmt[] = [];
    for (const stmt of stmts) {
        if (stmt.kind === 'let' && !used[stmt.id] && isPure(stmt.value)) continue;
        if (stmt.kind === 'if') {
            out.push({
                ...stmt,
                then: eliminateStmts(stmt.then, used),
                otherwise: stmt.otherwise ? eliminateStmts(stmt.otherwise, used) : null,
            });
            continue;
        }
        if (stmt.kind === 'loop') {
            out.push({ ...stmt, body: eliminateStmts(stmt.body, used) });
            continue;
        }
        out.push(stmt);
    }
    return out;
}

function isPure(expr: IrExpr): boolean {
    switch (expr.kind) {
        case 'literal':
        case 'local':
        case 'binding':
        case 'builtin':
            return true;
        case 'unary':
            return isPure(expr.value);
        case 'binary':
            return isPure(expr.left) && isPure(expr.right);
        case 'construct':
            return expr.args.every(isPure);
        case 'swizzle':
            return isPure(expr.value);
        case 'access':
            return isPure(expr.value) && (typeof expr.index === 'string' || isPure(expr.index));
        case 'call':
        case 'sample':
            return false;
    }
}

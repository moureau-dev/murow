/**
 * DSL values.
 *
 * `ShaderValue` is a thin wrapper around an IR expression. All arithmetic is
 * explicit method calls that build IR nodes, so the IR stays the source of
 * truth. Native JS operators (`a * b`) are only available through the future
 * build-time transform; the runtime builder uses these methods and `std.*`.
 *
 * Pure. No backend, no device.
 */
import type { GpuScalar, GpuType, ScalarType, VecType } from '../types';
import type { IrExpr } from '../ir';
import { binary, call, swizzle as irSwizzle, unary } from '../ir';

/** Anything the DSL can turn into an IR expression. */
export type ShaderInput = ShaderValue | IrExpr | number | boolean;

export interface ShaderValueOptions {
    readonly node: IrExpr;
}

/** The scalar component type of a value. Non-numeric types default to `f32`. */
export function componentScalar(type: GpuType): GpuScalar {
    if (type.kind === 'vec' || type.kind === 'mat' || type.kind === 'scalar') return type.scalar;
    return 'f32';
}

/** The unary scalar type matching a value's components. */
export function scalarOf(type: GpuType): ScalarType {
    return { kind: 'scalar', scalar: componentScalar(type) };
}

/** A vector type matching a value's scalar components. */
export function vecOf(type: GpuType, width: 2 | 3 | 4): VecType {
    return { kind: 'vec', scalar: componentScalar(type), width };
}

/** The wider of two operand types: a scalar widened by a vector or matrix. */
export function combineType(left: GpuType, right: GpuType): GpuType {
    if (left.kind === 'scalar' && right.kind !== 'scalar') return right;
    return left;
}

/** Unwrap a DSL argument to an IR expression. Numbers become `f32` literals. */
export function toExpr(value: ShaderInput): IrExpr {
    if (value instanceof ShaderValue) return value.node;
    if (typeof value === 'number') {
        return { kind: 'literal', type: { kind: 'scalar', scalar: 'f32' }, value };
    }
    if (typeof value === 'boolean') {
        return { kind: 'literal', type: { kind: 'scalar', scalar: 'bool' }, value };
    }
    return value;
}

/** A typed value in a shader body. */
export class ShaderValue {
    readonly node: IrExpr;

    constructor(options: ShaderValueOptions) {
        this.node = options.node;
    }

    /** The IR type of the wrapped expression. */
    get type(): GpuType {
        return this.node.type;
    }

    add(other: ShaderInput): ShaderValue {
        return this.binop('+', other);
    }

    sub(other: ShaderInput): ShaderValue {
        return this.binop('-', other);
    }

    mul(other: ShaderInput): ShaderValue {
        return this.binop('*', other);
    }

    div(other: ShaderInput): ShaderValue {
        return this.binop('/', other);
    }

    neg(): ShaderValue {
        return new ShaderValue({ node: unary(this.type, '-', this.node) });
    }

    dot(other: ShaderInput): ShaderValue {
        const right = toExpr(other);
        const type = scalarOf(combineType(this.type, right.type));
        return new ShaderValue({ node: call(type, 'dot', [this.node, right]) });
    }

    swizzle(mask: string): ShaderValue {
        return new ShaderValue({ node: irSwizzle(this.node, mask) });
    }

    get x(): ShaderValue {
        return this.swizzle('x');
    }

    get y(): ShaderValue {
        return this.swizzle('y');
    }

    get z(): ShaderValue {
        return this.swizzle('z');
    }

    get w(): ShaderValue {
        return this.swizzle('w');
    }

    get r(): ShaderValue {
        return this.swizzle('r');
    }

    get g(): ShaderValue {
        return this.swizzle('g');
    }

    get b(): ShaderValue {
        return this.swizzle('b');
    }

    get a(): ShaderValue {
        return this.swizzle('a');
    }

    private binop(op: string, other: ShaderInput): ShaderValue {
        const right = toExpr(other);
        const type = combineType(this.type, right.type);
        return new ShaderValue({ node: binary(type, op, this.node, right) });
    }
}

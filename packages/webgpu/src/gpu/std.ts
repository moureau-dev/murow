/**
 * A typegpu-compatible `std` namespace backed by `murow/gpu`.
 *
 * The DSL `std` builds IR directly. Two entry points differ from its argument
 * order, so they are wrapped here to match the surface shader code already
 * uses: `select(falseValue, trueValue, cond)` and `textureSampleLevel(...)`.
 *
 * Pure. No device, no allocations in hot paths.
 */
import { std as dslStd, ShaderValue, toExpr } from 'murow/gpu/dsl';
import { call, u32 as u32Type, vec } from 'murow/gpu/ir';
import type { ShaderInput } from 'murow/gpu/dsl';

function value(node: ReturnType<typeof call>): ShaderValue {
    return new ShaderValue({ node });
}

/** The typegpu-compatible standard math namespace. */
export const std = {
    ...dslStd,

    /** `select(falseValue, trueValue, condition)`. */
    select(falseValue: ShaderInput, trueValue: ShaderInput, condition: ShaderInput): ShaderValue {
        return dslStd.select(condition, falseValue, trueValue);
    },

    /** Clamp to the unit interval. WGSL has no `saturate`, so emit a clamp. */
    saturate(x: ShaderInput): ShaderValue {
        return dslStd.clamp(x, 0, 1);
    },

    /**
     * Sample a texture at an explicit mip level. Accepts an optional array
     * index before the level for arrayed textures, matching the engine's call
     * sites, so the extra arguments pass straight through.
     */
    textureSampleLevel(...args: ShaderInput[]): ShaderValue {
        return value(call(vec('f32', 4), 'textureSampleLevel', args.map(toExpr)));
    },

    /** Atomically add to a storage-buffer atomic and return the previous value. */
    atomicAdd(pointer: ShaderInput, value_: ShaderInput): ShaderValue {
        return value(call(u32Type(), 'atomicAdd', [toExpr(pointer), toExpr(value_)]));
    },

    /** Atomically load a storage-buffer atomic. */
    atomicLoad(pointer: ShaderInput): ShaderValue {
        return value(call(u32Type(), 'atomicLoad', [toExpr(pointer)]));
    },
};

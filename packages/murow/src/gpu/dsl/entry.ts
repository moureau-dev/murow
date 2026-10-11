/**
 * Shader entry points.
 *
 * The lowercase `shader` namespace builds `IrEntry` nodes. A body may return an
 * expression (wrapped in a return statement) or an array of statements.
 *
 * Pure. No backend, no device.
 */
import type { GpuType } from '../types';
import type { IrEntry, IrExpr, IrParam, IrStmt } from '../ir/nodes';
import { isExpr } from '../ir/nodes';
import { binding, builtin, entry, param, returnStmt } from '../ir/builders';
import { ShaderValue } from './value';
import { std as stdLib } from './std';

export interface ShaderEntryOptions {
    readonly params?: Record<string, GpuType>;
    readonly material?: Record<string, GpuType>;
    readonly workgroupSize?: readonly [number, number, number];
}

/** A shader entry body. Receives inputs, materials, and the `std` namespace. */
export type ShaderBody = (
    params: Record<string, ShaderValue>,
    material: Record<string, ShaderValue>,
    s: typeof stdLib,
) => IrStmt[] | IrExpr | IrStmt | ShaderValue;

function buildParams(schema: Record<string, GpuType> | undefined): {
    values: Record<string, ShaderValue>;
    params: IrParam[];
} {
    const values: Record<string, ShaderValue> = {};
    const params: IrParam[] = [];
    let location = 0;
    for (const name of Object.keys(schema ?? {})) {
        const type = (schema as Record<string, GpuType>)[name];
        values[name] = new ShaderValue({ node: builtin(type, name) });
        params.push(param(name, type, location++));
    }
    return { values, params };
}

function buildMaterial(schema: Record<string, GpuType> | undefined): Record<string, ShaderValue> {
    const values: Record<string, ShaderValue> = {};
    let index = 0;
    for (const name of Object.keys(schema ?? {})) {
        const type = (schema as Record<string, GpuType>)[name];
        values[name] = new ShaderValue({ node: binding(type, 0, index++) });
    }
    return values;
}

function normalizeBody(result: IrStmt[] | IrExpr | IrStmt | ShaderValue): IrStmt[] {
    if (Array.isArray(result)) return result;
    if (result instanceof ShaderValue) return [returnStmt(result.node)];
    if (isExpr(result)) return [returnStmt(result)];
    return [result];
}

function run(stage: 'vertex' | 'fragment' | 'compute', fn: ShaderBody, options: ShaderEntryOptions): IrEntry {
    const inputs = buildParams(options.params);
    const material = buildMaterial(options.material);
    const body = normalizeBody(fn(inputs.values, material, stdLib));
    return entry({
        stage,
        params: inputs.params,
        body,
        ...(options.workgroupSize ? { workgroupSize: options.workgroupSize } : {}),
    });
}

function resolve(
    a: ShaderBody | ShaderEntryOptions,
    b?: ShaderBody | ShaderEntryOptions,
): [ShaderBody, ShaderEntryOptions] {
    if (typeof a === 'function') return [a, (b as ShaderEntryOptions) ?? {}];
    return [b as ShaderBody, a];
}

/** Build a vertex entry. */
export function vertex(a: ShaderBody | ShaderEntryOptions, b?: ShaderBody | ShaderEntryOptions): IrEntry {
    const [fn, options] = resolve(a, b);
    return run('vertex', fn, options);
}

/** Build a fragment entry. */
export function fragment(a: ShaderBody | ShaderEntryOptions, b?: ShaderBody | ShaderEntryOptions): IrEntry {
    const [fn, options] = resolve(a, b);
    return run('fragment', fn, options);
}

/** Build a compute entry. Compute is a backend capability. */
export function compute(a: ShaderBody | ShaderEntryOptions, b?: ShaderBody | ShaderEntryOptions): IrEntry {
    const [fn, options] = resolve(a, b);
    return run('compute', fn, { workgroupSize: [1, 1, 1], ...options });
}

/** Portable entry factories. Backends compose their own `shader` adding compute. */
export const shader = { vertex, fragment };

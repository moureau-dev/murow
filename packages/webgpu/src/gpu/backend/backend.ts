/**
 * The WGSL backend.
 *
 * Supplies the WGSL syntax, the WGSL-only intrinsics, the WGSL helper source,
 * and a `GpuBackendSpec` ready for `new GpuBackend(wgslSpec)`. Also exposes the
 * `WgslBackend` `BaseBackend` subclass still used by the renderer facade.
 *
 * Pure. No device.
 */
import {
    GpuBackend,
    GpuProgram,
    type GpuBackendSpec,
    type GpuCompiledShader,
    type GpuShader,
} from 'murow/gpu';
import {
    ALL_CAPABILITIES,
    BaseBackend,
    createDefaultIntrinsics,
    type BaseBackendOptions,
    type Capabilities,
    type IntrinsicImpl,
} from 'murow/gpu/codegen';
import { walkEntry, type IrEntry } from 'murow/gpu/ir';
import { HELPER_WGSL } from '../../shaders';
import { WgslSyntax } from '../syntax';

/** WGSL atomic intrinsics whose first argument must be a pointer. */
const ATOMIC_INTRINSICS = [
    'atomicLoad',
    'atomicStore',
    'atomicAdd',
    'atomicSub',
    'atomicMax',
    'atomicMin',
    'atomicAnd',
    'atomicOr',
    'atomicXor',
    'atomicExchange',
    'atomicCompareExchangeWeak',
] as const;

/**
 * WGSL-only intrinsics the DSL exposes but WGSL has no function for. `saturate`
 * lowers to `clamp`; atomics take a pointer.
 */
export function wgslIntrinsics(): Record<string, IntrinsicImpl> {
    const table: Record<string, IntrinsicImpl> = {
        saturate: (args, ctx) => {
            const value = ctx.backend.emitNode(args[0]!, ctx);
            const type = args[0]!.type;
            if (type.kind === 'vec') {
                return `clamp(${value}, vec${type.width}<f32>(0.0), vec${type.width}<f32>(1.0))`;
            }
            return `clamp(${value}, 0.0, 1.0)`;
        },
    };
    for (const name of ATOMIC_INTRINSICS) {
        table[name] = (args, ctx) => {
            const pointer = ctx.backend.emitNode(args[0]!, ctx);
            const target = pointer.startsWith('&') ? pointer : `&${pointer}`;
            const rest = args.slice(1).map((arg) => ctx.backend.emitNode(arg, ctx));
            return `${name}(${[target, ...rest].join(', ')})`;
        };
    }
    return table;
}

/** The WGSL backend spec: syntax, intrinsics, helpers, all capabilities on. */
export const wgslSpec: GpuBackendSpec = {
    name: 'wgsl',
    capabilities: ALL_CAPABILITIES,
    syntax: new WgslSyntax(),
    intrinsics: wgslIntrinsics(),
    helpers: HELPER_WGSL,
};

/** Link and compile shaders to WGSL with the WGSL backend. */
export function compileProgram(shaders: readonly GpuShader[]): GpuCompiledShader {
    const result = new GpuBackend(wgslSpec).compile(GpuProgram.link(shaders));
    return { ...result, code: patchWgsl(result.code) };
}

/**
 * Rewrite emitted WGSL to what the module needs: `$` names and lone `_`
 * identifiers are invalid, and mutable locals the emitter declares with `let`
 * must be `var`.
 */
function patchWgsl(code: string): string {
    let out = code;
    if (out.includes('$')) out = out.replace(/\$/g, 'zz');
    if (out.includes('_')) out = out.replace(/(?<![\w$])_(?![\w$])/g, 'zz_');
    return out.replace(/let (?![^;]*&)/g, 'var ');
}

/** Options accepted by {@link WgslBackend}. */
export interface WgslBackendOptions extends Omit<BaseBackendOptions, 'syntax' | 'name' | 'capabilities'> {
    readonly name?: string;
    readonly capabilities?: Partial<Capabilities>;
}

/** The WGSL backend: `BaseBackend` with WGSL syntax and all capabilities on. */
export class WgslBackend extends BaseBackend {
    constructor(options: WgslBackendOptions = {}) {
        const intrinsics = options.intrinsics ?? createDefaultIntrinsics();
        for (const name of Object.keys(wgslIntrinsics())) intrinsics.override(name, wgslIntrinsics()[name]!);
        super({
            ...options,
            intrinsics,
            syntax: new WgslSyntax(),
            name: options.name ?? 'wgsl',
            capabilities: { ...ALL_CAPABILITIES, ...(options.capabilities ?? {}) },
        });
    }

    /**
     * Emit the base preamble, then the source of every engine helper the entry
     * calls. Helpers are injected once and only when used.
     */
    override preamble(entry: IrEntry, ctx: Parameters<BaseBackend['preamble']>[1]): string {
        const base = super.preamble(entry, ctx);
        const used = collectHelperNames(entry);
        if (used.length === 0) return base;
        const helpers = used.map((name) => HELPER_WGSL[name]!).join('\n');
        return base.length > 0 ? `${base}\n${helpers}` : helpers;
    }
}

/** Names of engine helpers referenced by a call in the entry, in stable order. */
function collectHelperNames(entry: IrEntry): string[] {
    const found: string[] = [];
    walkEntry(entry, (node) => {
        if (node.kind !== 'call') return;
        const name = (node as { name: string }).name;
        if (!(name in HELPER_WGSL)) return;
        if (!found.includes(name)) found.push(name);
    });
    return found;
}

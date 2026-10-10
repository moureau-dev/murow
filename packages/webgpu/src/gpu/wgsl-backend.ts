/**
 * The WGSL code generator for `murow/gpu`.
 *
 * `murow/gpu` is target-agnostic; this backend supplies the WGSL syntax and
 * enables every WebGPU capability. Shared by the renderer's material pipeline
 * and any other WebGPU code that compiles `murow/gpu` IR.
 */
import {
    ALL_CAPABILITIES,
    BaseBackend,
    createDefaultIntrinsics,
    type BaseBackendOptions,
    type Capabilities,
    type IntrinsicRegistry,
} from 'murow/gpu/codegen';
import { walkEntry, type IrEntry } from 'murow/gpu/ir';
import { HELPER_WGSL } from './helpers';
import { WgslSyntax } from './wgsl-syntax';

/**
 * Add the WGSL-only intrinsics the DSL exposes but WGSL has no function for.
 * `saturate` lowers to `clamp`, expanding the bounds to the operand's width so
 * a vector saturate stays vector typed.
 */
function registerWgslIntrinsics(registry: IntrinsicRegistry): void {
    registry.override('saturate', (args, ctx) => {
        const value = ctx.backend.emitNode(args[0]!, ctx);
        const type = args[0]!.type;
        if (type.kind === 'vec') {
            return `clamp(${value}, vec${type.width}<f32>(0.0), vec${type.width}<f32>(1.0))`;
        }
        return `clamp(${value}, 0.0, 1.0)`;
    });
    // WGSL atomics take a pointer; the DSL passes the storage access directly.
    for (const name of ATOMIC_INTRINSICS) {
        registry.override(name, (args, ctx) => {
            const pointer = ctx.backend.emitNode(args[0]!, ctx);
            const target = pointer.startsWith('&') ? pointer : `&${pointer}`;
            const rest = args.slice(1).map((arg) => ctx.backend.emitNode(arg, ctx));
            return `${name}(${[target, ...rest].join(', ')})`;
        });
    }
}

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

/** Options accepted by {@link WgslBackend}. */
export interface WgslBackendOptions extends Omit<BaseBackendOptions, 'syntax' | 'name' | 'capabilities'> {
    readonly name?: string;
    readonly capabilities?: Partial<Capabilities>;
}

/** The WGSL backend: `BaseBackend` with WGSL syntax and all capabilities on. */
export class WgslBackend extends BaseBackend {
    constructor(options: WgslBackendOptions = {}) {
        const intrinsics = options.intrinsics ?? createDefaultIntrinsics();
        registerWgslIntrinsics(intrinsics);
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
     * calls. Helpers are injected once and only when used, so an entry that
     * does not call noise or lightContribution stays small.
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

/**
 * A typegpu-compatible `tgpu` facade backed by `murow/gpu` and raw WebGPU.
 *
 * `tgpu` mirrors the typegpu surface the renderer uses: `init`/`initFromDevice`
 * return a {@link GpuRoot}, the entry wrappers mark functions with their stage
 * and schemas, and `resolveWithContext` lowers marked functions to `murow/gpu`
 * IR through the parser, then emits WGSL through the `WgslBackend`.
 *
 * Pure at module scope; a device is only touched by `init` and the root.
 */
import {
    createEmitContext,
    indentText,
    PassPipeline,
    SHARED_PASSES,
} from 'murow/gpu/codegen';
import {
    call,
    output as outputNode,
    walkEntry,
    type GpuType,
    type IrBinding,
    type IrEntry,
    type IrOutput,
    type IrParam,
    type StructType,
} from 'murow/gpu/ir';
import { ShaderValue, toExpr } from 'murow/gpu/dsl';
import { parseShaderBody } from 'murow/gpu/compiler';
import { d as facadeD, typeOf } from 'murow/gpu/dsl';
import { handleView } from './environment';
import { HELPER_WGSL } from './helpers';
import { std as facadeStd } from 'murow/gpu/dsl';
import { WgslBackend } from './backend';
import {
    createLayoutHandle,
    GpuRoot,
    setGpuResolver,
    type GpuBuffer,
    type LayoutHandle,
    type PlainBindGroupLayoutDescriptor,
    type PlainBindingEntry,
} from './root';

/**
 * Functions and the lazy externals providers recorded by
 * {@link attachShaderMetadata}. Parallel arrays, no `Map`.
 */
const metadataFns: Function[] = [];
const metadataGetters: Array<() => Record<string, unknown>> = [];
const metadataSources: Array<string | undefined> = [];
const metadataStrip: boolean[] = [];
const metadataAliases: Array<Record<string, unknown>> = [];

/** A recorded externals provider, with an optional source override. */
interface ShaderMetadata {
    readonly getExternals: () => Record<string, unknown>;
    readonly aliases: Record<string, unknown>;
    readonly source?: string;
    readonly stripFirstParam: boolean;
}

/** Record the externals provider for a shader function. */
export function attachShaderMetadata(
    fn: Function,
    getExternals: () => Record<string, unknown>,
    stripFirstParam = false,
    aliases: Record<string, object> = {},
    _knownExternalNames?: string[],
    sourceOverride?: string,
): void {
    (globalThis as { __murow_ensureShaderPatch?: () => void }).__murow_ensureShaderPatch?.();
    const index = metadataFns.indexOf(fn);
    if (index >= 0) {
        metadataGetters[index] = getExternals;
        metadataSources[index] = sourceOverride;
        metadataStrip[index] = stripFirstParam;
        metadataAliases[index] = aliases as Record<string, unknown>;
        return;
    }
    metadataFns.push(fn);
    metadataGetters.push(getExternals);
    metadataSources.push(sourceOverride);
    metadataStrip.push(stripFirstParam);
    metadataAliases.push(aliases as Record<string, unknown>);
}

/** Metadata recorded for a function, if any. */
function metadataFor(fn: Function | undefined): ShaderMetadata | undefined {
    if (!fn) return undefined;
    const index = metadataFns.indexOf(fn);
    if (index < 0) return undefined;
    return {
        getExternals: metadataGetters[index]!,
        aliases: metadataAliases[index] ?? {},
        stripFirstParam: metadataStrip[index] ?? false,
        ...(metadataSources[index] ? { source: metadataSources[index] } : {}),
    };
}

/**
 * Remove the first parameter from a function source. The names it destructures
 * become externals, so the bodies that rely on this keep working unchanged.
 */
function stripFirstParam(source: string): string {
    const open = source.indexOf('(');
    if (open === -1) return source;
    let depth = 0;
    for (let i = open + 1; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
            return source.slice(0, open + 1) + source.slice(i + 1);
        }
    }
    return source;
}

/**
 * Layout handles seen by one resolve call, in first-use order. Each handle is
 * assigned a bind group index so the emitted WGSL matches the pipeline layout
 * the renderer builds.
 */
class LayoutGroups {
    readonly handles: LayoutHandle[] = [];

    /** Group index for a handle, assigning the next slot when first seen. */
    groupOf(handle: LayoutHandle): number {
        const found = this.handles.indexOf(handle);
        if (found >= 0) return found;
        const index = this.handles.length;
        this.handles.push(handle);
        return index;
    }
}

/** Options accepted by `tgpu.initFromDevice`. */
export interface TgpuInitOptions {
    readonly device: GPUDevice;
}

/** A marked shader entry produced by an entry wrapper. */
export interface TgpuFnHandle {
    readonly __tgpuFn: true;
    readonly fn: Function;
    readonly argTypes: any;
    readonly returnType: any;
    readonly stage?: 'vertex' | 'fragment' | 'compute';
    readonly options?: TgpuFnOptions;
    /**
     * Source override used instead of `fn.toString()`. A front-end that reuses
     * a placeholder function can keep the real body here.
     */
    readonly source?: string;
    /** Named externals (layouts, scene uniforms, helpers) the body may read. */
    readonly externals?: Record<string, unknown>;
}

/** Options accepted by the entry wrappers. */
export interface TgpuFnOptions {
    readonly in?: Record<string, any>;
    readonly out?: Record<string, any> | any;
    readonly workgroupSize?: readonly [number, number, number];
    /** Named externals the shader body may reference. */
    readonly externals?: Record<string, unknown>;
}

/** Options accepted by `tgpu.vertexFn` and `tgpu.fragmentFn`. */
export type TgpuVertexOptions = TgpuFnOptions;

/** Options accepted by `tgpu.computeFn`. */
export interface TgpuComputeOptions {
    readonly in?: Record<string, any>;
    readonly workgroupSize?: readonly [number, number, number];
    readonly externals?: Record<string, unknown>;
}

/** The typegpu-compatible facade. */
export const tgpu = {
    /** Create a root around an existing device. */
    initFromDevice(options: TgpuInitOptions): GpuRoot {
        return new GpuRoot({ device: options.device });
    },

    /** Create a root by requesting an adapter and device from WebGPU. */
    async init(): Promise<GpuRoot> {
        const gpu = (globalThis as any).navigator?.gpu;
        if (!gpu) throw new Error('tgpu.init: WebGPU is not available; use tgpu.initFromDevice');
        const adapter = await gpu.requestAdapter();
        if (!adapter) throw new Error('tgpu.init: no GPU adapter available');
        const device = await adapter.requestDevice();
        return new GpuRoot({ device });
    },

    /**
     * Mark a plain helper shader function with its signature. The result is
     * callable: shader bodies call it with IR expressions and it lowers to a
     * call node the backend injects as a helper.
     */
    fn(argTypes: readonly any[], returnType: any) {
        return (fn: Function): TgpuFnHandle => {
            const ret = irTypeOf(returnType);
            const name = fn.name || 'fn';
            const callable = (...args: any[]): any =>
                new ShaderValue({ node: call(ret, name, args.map(toExpr)) });
            return Object.assign(callable, {
                __tgpuFn: true as const,
                fn,
                argTypes,
                returnType,
            }) as unknown as TgpuFnHandle;
        };
    },

    /** Mark a vertex shader function. */
    vertexFn(options: TgpuVertexOptions) {
        return (fn: Function): TgpuFnHandle => ({
            __tgpuFn: true,
            fn,
            argTypes: options?.in,
            returnType: options?.out,
            stage: 'vertex',
            options,
            externals: options?.externals,
        });
    },

    /** Mark a fragment shader function. */
    fragmentFn(options: TgpuVertexOptions) {
        return (fn: Function): TgpuFnHandle => ({
            __tgpuFn: true,
            fn,
            argTypes: options?.in,
            returnType: options?.out,
            stage: 'fragment',
            options,
            externals: options?.externals,
        });
    },

    /** Mark a compute shader function. */
    computeFn(options: TgpuComputeOptions) {
        return (fn: Function): TgpuFnHandle => ({
            __tgpuFn: true,
            fn,
            argTypes: options?.in,
            returnType: undefined,
            stage: 'compute',
            options,
            externals: options?.externals,
        });
    },

    /**
     * Build a bind group layout from a typegpu-style descriptor of named
     * slots. A provided root materializes the raw layout immediately;
     * otherwise the handle materializes lazily on `root.unwrap`.
     */
    bindGroupLayout(
        descriptor: Record<string, PlainBindingEntry['resource']>,
        options: { root?: GpuRoot } = {},
    ): LayoutHandle {
        const plain = toPlainLayoutDescriptor(descriptor);
        if (options.root) return options.root.bindGroupLayout(plain);
        return createLayoutHandle({ descriptor: plain, group: 0 });
    },

    /**
     * Lower and emit WGSL for a list of entries. Entries may be IR entries or
     * marked wrappers, and may carry named externals. Bind group layouts seen by
     * the entries are numbered in first-use order so the caller can match the
     * pipeline layout.
     */
    resolveWithContext(fns: readonly any[]): { code: string; layouts: LayoutHandle[] } {
        const groups = new LayoutGroups();
        for (const fn of fns) {
            const meta = metadataFor(fn?.fn ?? fn);
            if (meta) scanHandles({ ...meta.aliases, ...meta.getExternals() }, groups, 0);
        }
        const entries = fns.map((fn) => toIrEntry(fn, groups));
        return { code: emitProgram(entries), layouts: groups.handles };
    },
};

setGpuResolver((entries) => tgpu.resolveWithContext(entries));

/** Map a schema value or type descriptor to an IR type. */
function irTypeOf(value: any): GpuType {
    return typeOf(value);
}

/**
 * Walk an externals record for layout handles. Called before parsing so each
 * handle's bind group index is fixed before its accessors build binding nodes.
 */
function scanHandles(value: unknown, groups: LayoutGroups, depth: number): void {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (typeof value === 'function') return;
    if ((value as { __descriptor?: unknown }).__descriptor) {
        groups.groupOf(value as LayoutHandle);
        return;
    }
    if ((value as { __handle?: unknown }).__handle) {
        groups.groupOf((value as { __handle: LayoutHandle }).__handle);
        return;
    }
    const node = (value as { node?: { kind?: string } }).node;
    if (node && typeof node.kind === 'string') return;
    if (Array.isArray(value)) {
        for (const item of value) scanHandles(item, groups, depth + 1);
        return;
    }
    for (const key of Object.keys(value as object)) {
        scanHandles((value as Record<string, unknown>)[key], groups, depth + 1);
    }
}

function toPlainLayoutDescriptor(
    descriptor: Record<string, PlainBindingEntry['resource']>,
): PlainBindGroupLayoutDescriptor {
    const entries: PlainBindingEntry[] = [];
    let binding = 0;
    for (const name of Object.keys(descriptor)) {
        entries.push({
            name,
            binding: binding++,
            visibility: { vertex: true, fragment: true, compute: true },
            resource: classifyResource(descriptor[name]),
        });
    }
    return { group: 0, entries };
}

function classifyResource(value: any): PlainBindingEntry['resource'] {
    if (value && typeof value === 'object') {
        if ('uniform' in value) return { uniform: value.uniform };
        if ('storage' in value) {
            return {
                storage: value.storage,
                ...(value.access ? { access: value.access } : {}),
                ...(value.readwrite ? { readwrite: true } : {}),
            };
        }
        if ('readonly-storage' in value) return { 'read-only-storage': value['readonly-storage'] };
        if ('read-only-storage' in value) return { 'read-only-storage': value['read-only-storage'] };
        if ('texture' in value) return { texture: value.texture, viewDimension: value.viewDimension };
        if ('sampler' in value) return { sampler: value.sampler };
        if ('storageTexture' in value) return { storageTexture: value.storageTexture };
    }
    return {};
}

/**
 * Turn a wrapper (or a prebuilt IR entry) into an IR entry. Wrappers are
 * lowered from their function source through the `murow/gpu` parser.
 */
function toIrEntry(fn: any, groups: LayoutGroups): IrEntry {
    if (fn && typeof fn.stage === 'string' && Array.isArray(fn.body)) return fn as IrEntry;
    if (fn?.__ir) return fn.__ir as IrEntry;
    if (!fn?.__tgpuFn) {
        throw new Error('tgpu.resolveWithContext: value is not a shader entry or wrapper');
    }
    const stage = fn.stage ?? 'fragment';
    const meta = metadataFor(fn.fn);
    let source = normalizeSource(meta?.source ?? fn.source ?? fn.fn.toString());
    if (meta?.stripFirstParam) source = stripFirstParam(source);
    const externals = buildExternals(
        {
            ...(meta ? meta.aliases : {}),
            ...(meta ? meta.getExternals() : {}),
            ...(fn.externals ?? {}),
            ...(fn.options?.externals ?? {}),
        },
        groups,
    );
    const { params, builtins, builtinNames } = buildInputs(fn.options?.in);
    const outputs = buildOutputs(fn.options?.out);
    return parseShaderBody(source, {
        stage,
        params,
        builtins,
        builtinNames,
        outputs,
        externals,
        ...(fn.options?.workgroupSize ? { workgroupSize: fn.options.workgroupSize } : {}),
    });
}

/**
 * Normalize an externals record for the parser: layouts become IR-valued views,
 * and `d`/`std` are replaced with the facade namespaces.
 */
/**
 * Reassign the bind group of binding values pre-built from a layout's `$`
 * accessors. Those values bake the handle's default group, so a second layout
 * (for example a material layout) would collide with the first. Values carry
 * their originating handle, so the group is resolved from the shared index.
 */
function assignGroups(value: unknown, groups: LayoutGroups, depth: number): void {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (typeof value === 'function') return;
    const tagged = value as { __handle?: LayoutHandle; node?: { group?: number; kind?: string } };
    if (tagged.__handle && tagged.node && typeof tagged.node.kind === 'string') {
        // Keep an explicitly assigned group; only resolve the default (0) so a
        // second layout does not collide with the first.
        if (tagged.node.group === 0) tagged.node.group = groups.groupOf(tagged.__handle);
        return;
    }
    if (tagged.node && typeof tagged.node.kind === 'string') return;
    if (Array.isArray(value)) {
        for (const item of value) assignGroups(item, groups, depth + 1);
        return;
    }
    for (const key of Object.keys(value as object)) {
        assignGroups((value as Record<string, unknown>)[key], groups, depth + 1);
    }
}

function buildExternals(
    raw: Record<string, unknown>,
    groups: LayoutGroups,
): Record<string, unknown> {
    const externals: Record<string, unknown> = { ...raw };
    for (const key of Object.keys(externals)) {
        const value = externals[key] as { __descriptor?: unknown } | undefined;
        if (value && typeof value === 'object' && value.__descriptor) {
            const handle = value as unknown as LayoutHandle;
            externals[key] = handleView(handle, groups.groupOf(handle));
        }
    }
    externals.d = facadeD;
    externals.std = facadeStd;
    for (const key of Object.keys(externals)) {
        assignGroups(externals[key], groups, 0);
    }
    return externals;
}

/**
 * Build the entry parameters (locations) and stage builtins. A `d.builtin`
 * marker becomes a builtin parameter; a `d.location` marker (or a bare type)
 * becomes a `@location` parameter.
 */
function buildInputs(schema: Record<string, any> | undefined): {
    params: Record<string, GpuType>;
    builtins: Record<string, GpuType>;
    builtinNames: Record<string, string>;
} {
    const params: Record<string, GpuType> = {};
    const builtins: Record<string, GpuType> = {};
    const builtinNames: Record<string, string> = {};
    if (!schema) return { params, builtins, builtinNames };
    for (const name of Object.keys(schema)) {
        const spec = schema[name];
        if (spec && typeof spec === 'object' && typeof spec.__builtin === 'string') {
            builtins[name] = spec.type;
            builtinNames[name] = spec.__builtin;
            continue;
        }
        params[name] = inputType(spec);
    }
    return { params, builtins, builtinNames };
}

/** Build vertex outputs from an `out` schema object. */
function buildOutputs(schema: Record<string, any> | undefined): IrOutput[] | undefined {
    if (!schema || typeof schema !== 'object') return undefined;
    const outputs: IrOutput[] = [];
    let location = 0;
    for (const name of Object.keys(schema)) {
        const spec = schema[name];
        if (spec && typeof spec === 'object' && typeof spec.__builtin === 'string') {
            outputs.push(outputNode(name, spec.type, { builtin: spec.__builtin }));
        } else {
            outputs.push(outputNode(name, inputType(spec), { location: location++ }));
        }
    }
    return outputs.length > 0 ? outputs : undefined;
}

function inputType(spec: any): GpuType {
    if (spec && typeof spec === 'object' && spec.type && typeof spec.type.kind === 'string') return spec.type;
    if (spec && typeof spec.kind === 'string') return spec;
    return spec as GpuType;
}

/**
 * Normalize a function's source so the parser sees a parenthesized parameter
 * list. Function declarations and method shorthand are rewritten; arrows and
 * plain parameter lists are left alone.
 */
function normalizeSource(source: string): string {
    const trimmed = source.trim();
    if (trimmed.startsWith('(') || trimmed.startsWith('async')) return trimmed;
    if (trimmed.startsWith('function')) {
        return trimmed.replace(/^function\s*[A-Za-z0-9_$]*\s*/, '');
    }
    return trimmed;
}

/** Emit a WGSL module for one or more lowered IR entries. */
function emitProgram(entries: readonly IrEntry[]): string {
    const backend = new WgslBackend();
    const pipeline = new PassPipeline({ shared: SHARED_PASSES, backend: backend.passes });
    const lowered = entries.map((entry) => pipeline.run(entry));
    const ctx = createEmitContext(backend);
    const sections: string[] = [];

    const structs = mergeStructs(lowered);
    for (const type of structs) sections.push(backend.syntax.structDecl(type));
    for (const entry of lowered) {
        if (hasOutputs(entry)) sections.push(backend.syntax.outputStructDecl(entry));
    }

    const helpers = mergeHelpers(lowered);
    for (const helper of helpers) sections.push(helper);

    for (const bindingNode of mergeBindings(lowered)) {
        sections.push(backend.declareBinding(bindingNode, ctx));
    }

    for (const entry of lowered) {
        sections.push(`${backend.entryPointSignature(entry, ctx)} {`);
        ctx.indent = 1;
        for (const stmt of entry.body) sections.push(indentText(ctx.indent) + backend.emitNode(stmt, ctx));
        ctx.indent = 0;
        sections.push('}');
    }
    return sections.join('\n');
}

function hasOutputs(entry: IrEntry): boolean {
    return entry.stage === 'vertex' && entry.outputs !== undefined && entry.outputs.length > 0;
}

function mergeStructs(entries: readonly IrEntry[]): StructType[] {
    const out: StructType[] = [];
    for (const entry of entries) {
        walkEntry(entry, (node) => {
            if (node.kind !== 'binding') return;
            collectStructs(node.type, out);
        });
    }
    return out;
}

function collectStructs(type: GpuType, out: StructType[]): void {
    if (type.kind === 'array') {
        collectStructs(type.element, out);
        return;
    }
    if (type.kind !== 'struct') return;
    if (out.some((s) => s.name === type.name)) return;
    out.push(type);
    for (const field of type.fields) collectStructs(field.type, out);
}

function mergeBindings(entries: readonly IrEntry[]): IrBinding[] {
    const out: IrBinding[] = [];
    for (const entry of entries) {
        walkEntry(entry, (node) => {
            if (node.kind !== 'binding') return;
            const b = node as IrBinding;
            if (!out.some((x) => x.group === b.group && x.binding === b.binding)) out.push(b);
        });
    }
    return out;
}

function mergeHelpers(entries: readonly IrEntry[]): string[] {
    const names: string[] = [];
    for (const entry of entries) {
        walkEntry(entry, (node) => {
            if (node.kind !== 'call') return;
            const name = (node as { name: string }).name;
            if (name in HELPER_WGSL && !names.includes(name)) names.push(name);
        });
    }
    return names.map((name) => HELPER_WGSL[name]!);
}

/** Root alias for typegpu import sites. */
export type TgpuRoot = GpuRoot;
/** Buffer alias for typegpu import sites. */
export type TgpuBuffer<S = any> = GpuBuffer;
/** Bind group layout alias for typegpu import sites. */
export type TgpuBindGroupLayout = any;
/** Loose vertex function alias for typegpu import sites. */
export type TgpuVertexFn<In = any, Out = any> = any;
/** Loose fragment function alias for typegpu import sites. */
export type TgpuFragmentFn<In = any, Out = any> = any;
/** Loose compute function alias for typegpu import sites. */
export type TgpuComputeFn = any;
/** Loose render pipeline alias for typegpu import sites. */
export type TgpuRenderPipeline = any;
/** Loose bind group alias for typegpu import sites. */
export type TgpuBindGroup = any;
/** Loose compute pipeline alias for typegpu import sites. */
export type TgpuComputePipeline = any;
/** Loose schema alias for typegpu/data import sites. */
export type AnyWgslData = any;
/** Loose schema alias for typegpu/data import sites. */
export type AnyData = any;
/** Loose inferred-value alias for typegpu/data import sites. */
export type Infer<T = any> = any;

/**
 * Rewrite the shader source the way WGSL needs it on the way into a module:
 * `$` names and lone `_` identifiers are invalid, and mutable locals are
 * declared with `let` by the emitter but must be `var` in WGSL. Installed
 * lazily so no GPU global is touched at import time.
 */
(globalThis as { __murow_ensureShaderPatch?: () => void }).__murow_ensureShaderPatch = () => {
    const flag = globalThis as { __murow_shaderPatched?: boolean };
    if (flag.__murow_shaderPatched) return;
    flag.__murow_shaderPatched = true;
    if (typeof GPUDevice !== 'undefined' && GPUDevice.prototype?.createShaderModule) {
        const original = GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule = function (desc: GPUShaderModuleDescriptor) {
            if (desc && typeof desc.code === 'string') {
                let code = desc.code;
                if (code.indexOf('$') !== -1) code = code.replace(/\$/g, 'zz');
                if (code.indexOf('_') !== -1) code = code.replace(/(?<![\w$])_(?![\w$])/g, 'zz_');
                code = code.replace(/let (?![^;]*&)/g, 'var ');
                desc.code = code;
            }
            return original.call(this, desc);
        };
    }
};

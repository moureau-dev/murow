/**
 * The compile driver: IR entries to backend source, with a keyed artifact
 * registry.
 *
 * This is the runtime-independent half of the build-time transform. It takes an
 * already-built IR entry, runs the shared and backend lowering passes, emits
 * backend source, and caches the result by name. The source-to-IR half lives
 * behind {@link transformSource}.
 */
import type { IrEntry, IrStage } from '../ir/nodes';
import type { Backend } from '../codegen/backend';
import { emitEntry } from '../codegen/emit';
import { PassPipeline, SHARED_PASSES } from '../codegen/passes';
import { vertex as buildVertex, fragment as buildFragment, compute as buildCompute, type ShaderBody } from '../dsl/entry';
import { parseShaderBody, type ParseShaderOptions } from './parse';

/** A compiled shader: emitted source plus the metadata a call site needs. */
export interface CompiledShader {
    readonly name: string;
    readonly stage: IrStage;
    readonly code: string;
    readonly backend: string;
}

/** Options accepted by {@link ShaderCompiler}. */
export interface ShaderCompilerOptions {
    readonly backend: Backend;
}

/** One named entry to compile in a batch. */
export interface NamedEntry {
    readonly name: string;
    readonly entry: IrEntry;
}

/**
 * Compiles IR entries to backend source and caches the artifacts by name.
 *
 * Names are ids: artifacts sit in a dense array and a derived record maps a name
 * to its slot, consistent with the engine's other registries. No `Map`.
 */
export class ShaderCompiler {
    readonly backend: Backend;
    private readonly pipeline: PassPipeline;
    private readonly artifacts: CompiledShader[] = [];
    private readonly slots: Record<string, number> = Object.create(null);

    constructor(options: ShaderCompilerOptions) {
        this.backend = options.backend;
        this.pipeline = new PassPipeline({
            shared: SHARED_PASSES,
            backend: options.backend.passes,
        });
    }

    /** Number of cached artifacts. */
    get size(): number {
        return this.artifacts.length;
    }

    /**
     * Lower and emit one entry, then cache it under `name`. Throws when the name
     * is already compiled.
     */
    compile(entry: IrEntry, name: string): CompiledShader {
        if (name in this.slots) {
            throw new Error(`ShaderCompiler: '${name}' is already compiled`);
        }
        const lowered = this.pipeline.run(entry);
        const result = emitEntry(lowered, this.backend);
        const artifact: CompiledShader = {
            name,
            stage: lowered.stage,
            code: result.code,
            backend: this.backend.name,
        };
        this.slots[name] = this.artifacts.length;
        this.artifacts.push(artifact);
        return artifact;
    }

    /** Compile named entries in order. */
    compileAll(entries: readonly NamedEntry[]): readonly CompiledShader[] {
        return entries.map(({ name, entry }) => this.compile(entry, name));
    }

    /** Cached artifact for a name, or undefined. */
    get(name: string): CompiledShader | undefined {
        const slot = this.slots[name];
        return slot === undefined ? undefined : this.artifacts[slot];
    }

    /** Whether a name is compiled. */
    has(name: string): boolean {
        return name in this.slots;
    }
}

/** Options accepted by {@link transform}. */
export interface TransformOptions {
    readonly name: string;
    readonly backend: Backend;
    /** Reuse an existing compiler so artifacts share one registry. */
    readonly compiler?: ShaderCompiler;
}

/**
 * Compile a DSL shader builder to backend source.
 *
 * The DSL is an eager IR builder: this runs `build` through the `shader` entry
 * factory to produce an IR entry, then lowers and emits it. No source parser is
 * involved, so the shipped runtime never carries one.
 *
 * A parser front-end, which would additionally accept native `a * b` operators
 * and `if`/`for` by reading the function source, is a separate and larger
 * transform. It would sit outside the shipped package so no parser dependency
 * lands in the build output.
 */
export function transform(stage: IrStage, build: ShaderBody, options: TransformOptions): CompiledShader {
    const compiler = options.compiler ?? new ShaderCompiler({ backend: options.backend });
    const entry = stage === 'vertex'
        ? buildVertex(build)
        : stage === 'fragment'
            ? buildFragment(build)
            : buildCompute(build);
    return compiler.compile(entry, options.name);
}

/** Options accepted by {@link transformSource}: the parser options plus output. */
export interface TransformSourceOptions extends ParseShaderOptions {
    readonly name: string;
    readonly backend: Backend;
    readonly compiler?: ShaderCompiler;
}

/**
 * Compile a DSL shader body given as source text.
 *
 * This is the parser front-end: the body is parsed and lowered to IR (native
 * operators and `if`/`else` supported), then emitted. Use it from a bundler
 * plugin where the DSL function is available only as source.
 */
export function transformSource(source: string, options: TransformSourceOptions): CompiledShader {
    const entry = parseShaderBody(source, options);
    const compiler = options.compiler ?? new ShaderCompiler({ backend: options.backend });
    return compiler.compile(entry, options.name);
}

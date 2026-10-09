/**
 * Optional runtime front-end for dynamically authored shaders.
 *
 * Re-exports the authoring surface and compiles IR entries to backend source on
 * the fly. This path keeps a parser out of the default build; the build-time
 * transform (`murow/gpu/compiler`) is preferred and should be used instead
 * whenever a shader is known at build time.
 *
 * Imports only the DSL, the IR, and code generation. No device, no schema.
 */
import { shader, d, std, branch, loop, select, ShaderValue } from '../dsl';
import type { IrEntry } from '../ir';
import { emitEntry, WgslBackend, type Backend, type CodegenResult } from '../codegen';

export { shader, d, std, branch, loop, select, ShaderValue };

/** Options accepted by {@link RuntimeCompiler}. */
export interface RuntimeCompilerOptions {
    readonly backend?: Backend;
}

/**
 * Compile one IR entry to source using `backend`, defaulting to WGSL.
 *
 * For a reusable compiler instance, prefer {@link RuntimeCompiler}.
 */
export function compileShader(entry: IrEntry, backend: Backend = new WgslBackend()): string {
    return emitEntry(entry, backend).code;
}

/**
 * Compiles dynamically authored shader entries on demand.
 *
 * Holds one backend so repeated compiles share its registries and passes.
 */
export class RuntimeCompiler {
    private readonly backend: Backend;

    constructor(options: RuntimeCompilerOptions = {}) {
        this.backend = options.backend ?? new WgslBackend();
    }

    /** Lower and emit an entry, returning the source and its metadata. */
    compile(entry: IrEntry): CodegenResult {
        return emitEntry(entry, this.backend);
    }
}

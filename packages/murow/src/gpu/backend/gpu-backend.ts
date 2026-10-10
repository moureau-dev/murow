/**
 * A concrete, spec-driven GPU backend.
 *
 * A backend is configured, not subclassed. Supply a {@link GpuBackendSpec} with
 * the target syntax, capabilities, and any deltas over the shared intrinsics,
 * nodes, passes, and helpers. Hacking a target is spread-and-override.
 *
 * The backend is pure: it compiles `murow/gpu` IR to target source and never
 * touches a device.
 */
import {
    BaseBackend,
    createDefaultIntrinsics,
    NodeRegistry,
    emitProgram,
    collectHelperNames,
    type Capabilities,
    type IntrinsicImpl,
    type LoweringPass,
    type NodeImpl,
    type TargetSyntax,
} from '../codegen';
import type { IrEntry } from '../ir/nodes';
import type { GpuProgram } from '../shader/gpu-program';
import type { GpuBindGroupLayout } from '../resources/bind-group';

/** What a backend's runtime can do. Drives capability gating in shared code. */
export type GpuCapabilities = Capabilities;

/** Configuration for a {@link GpuBackend}. */
export interface GpuBackendSpec {
    /** Target name, for example `wgsl`. */
    readonly name: string;
    /** Runtime capabilities of the target. */
    readonly capabilities: Capabilities;
    /** Every target-specific string the walker needs. */
    readonly syntax: TargetSyntax;
    /** Intrinsic emitters merged over the shared defaults. */
    readonly intrinsics?: Readonly<Record<string, IntrinsicImpl>>;
    /** Node emitters registered on top of the shared walker. */
    readonly nodes?: Readonly<Record<string, NodeImpl>>;
    /** Lowering passes appended after the shared passes. */
    readonly passes?: readonly LoweringPass[];
    /** Helper source emitted once, only when a matching call appears. */
    readonly helpers?: Readonly<Record<string, string>>;
}

/** The output of compiling a program. */
export interface GpuCompiledShader {
    /** Emitted target source. */
    readonly code: string;
    /** Bind group layouts in group order, for the pipeline layout. */
    readonly layouts: readonly GpuBindGroupLayout[];
}

/**
 * A configured code generator. Construct one from a spec and call
 * {@link GpuBackend.compile} on a program.
 */
export class GpuBackend {
    /** Target name. */
    readonly name: string;
    /** Runtime capabilities. */
    readonly capabilities: Capabilities;

    private readonly base: BaseBackend;
    private readonly helpers: Readonly<Record<string, string>>;

    constructor(spec: GpuBackendSpec) {
        const intrinsics = createDefaultIntrinsics();
        for (const name of Object.keys(spec.intrinsics ?? {})) {
            intrinsics.override(name, spec.intrinsics![name]!);
        }
        const nodes = new NodeRegistry();
        for (const name of Object.keys(spec.nodes ?? {})) nodes.register(name, spec.nodes![name]!);

        this.name = spec.name;
        this.capabilities = spec.capabilities;
        this.helpers = spec.helpers ?? {};
        this.base = new BaseBackend({
            syntax: spec.syntax,
            name: spec.name,
            capabilities: spec.capabilities,
            intrinsics,
            nodes,
            passes: spec.passes ?? [],
        });
    }

    /** Compile a linked program to target source and its layouts. */
    compile(program: GpuProgram): GpuCompiledShader {
        const entries: readonly IrEntry[] = program.entries;
        const used = collectHelperNames(entries, this.helpers);
        const helpers = used.map((name) => this.helpers[name]!).join('\n');
        const result = emitProgram(entries, this.base, { helpers });
        return { code: result.code, layouts: program.layouts };
    }
}

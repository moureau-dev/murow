/**
 * Test support: a WGSL {@link TargetSyntax} and backend.
 *
 * This mirrors the WGSL strings the core used to emit so existing assertions
 * stay valid. It is test support code, not shipped API, and the production WGSL
 * backend lives in `murow/webgpu`.
 */
import type { GpuScalar, GpuType, StructType } from '../types';
import type { IrBinding, IrEntry, IrOutput, IrStage } from '../ir/nodes';
import {
    ALL_CAPABILITIES,
    BaseBackend,
    type BaseBackendOptions,
} from './backend';
import type { BindingKind, StorageAccess, TargetSyntax } from './syntax';

/** WGSL spelling of a type. Structs emit by name. */
function wgslType(type: GpuType): string {
    switch (type.kind) {
        case 'scalar':
            return type.scalar;
        case 'vec':
            return `vec${type.width}<${type.scalar}>`;
        case 'mat':
            return `mat${type.cols}x${type.rows}<${type.scalar}>`;
        case 'array': {
            const element = wgslType(type.element);
            return type.count === null ? `array<${element}>` : `array<${element}, ${type.count}>`;
        }
        case 'struct':
            return type.name;
        case 'texture': {
            const suffix = type.dim.replace(/-/g, '_');
            return type.depth
                ? `texture_depth_${suffix}`
                : `texture_${suffix}<${type.scalar}>`;
        }
        case 'sampler':
            return type.comparison ? 'sampler_comparison' : 'sampler';
    }
}

function formatScalar(scalar: GpuScalar, value: number): string {
    if (scalar === 'u32') return `${Math.trunc(value)}u`;
    if (scalar === 'i32') return String(Math.trunc(value));
    return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

/** WGSL target syntax used by tests. */
export class TestWgslSyntax implements TargetSyntax {
    readonly name = 'wgsl';

    /** WGSL spelling of a type. */
    typeName(type: GpuType): string {
        return wgslType(type);
    }

    /** WGSL attribute for a stage builtin. */
    builtin(name: string): string {
        switch (name) {
            case 'position':
            case 'frag_coord':
                return '@builtin(position)';
            case 'front_facing':
                return '@builtin(front_facing)';
            case 'invocation_id':
                return '@builtin(global_invocation_id)';
            default:
                return `@builtin(${name})`;
        }
    }

    /** WGSL entry input parameter. */
    paramDecl(location: number, name: string, type: GpuType): string {
        return `@location(${location}) ${name}: ${wgslType(type)}`;
    }

    /** WGSL return type suffix. */
    returnType(stage: IrStage, type: GpuType): string {
        if (stage === 'compute') return '';
        const spelling = wgslType(type);
        return stage === 'vertex'
            ? ` -> @builtin(position) ${spelling}`
            : ` -> @location(0) ${spelling}`;
    }

    /** WGSL entry attribute plus function head. */
    entrySignature(
        entry: IrEntry,
        params: readonly string[],
        name: string,
        outputStruct?: string,
    ): string {
        const attribute =
            entry.stage === 'compute'
                ? `@compute @workgroup_size(${(entry.workgroupSize ?? [1, 1, 1]).join(', ')})`
                : `@${entry.stage}`;
        const returns = outputStruct ? ` -> ${outputStruct}` : '';
        return `${attribute}\nfn ${name}(${params.join(', ')})${returns}`;
    }

    /** WGSL vertex output struct name. */
    outputStructName(_entry: IrEntry): string {
        return 'vs_out';
    }

    /** WGSL vertex output struct declaration. */
    outputStructDecl(entry: IrEntry): string {
        const fields = (entry.outputs ?? [])
            .map((field) => `    ${this.outputField(field)},`)
            .join('\n');
        return `struct ${this.outputStructName(entry)} {\n${fields}\n}`;
    }

    /** WGSL field of a vertex output struct. */
    outputField(output: IrOutput): string {
        const attribute =
            output.builtin !== undefined
                ? this.builtin(output.builtin)
                : `@location(${output.location ?? 0})`;
        return `${attribute} ${output.name}: ${wgslType(output.type)}`;
    }

    /** WGSL resource declaration. */
    declareBinding(
        binding: IrBinding,
        kind: BindingKind,
        access: StorageAccess | undefined,
        name: string,
    ): string {
        const head = `@group(${binding.group}) @binding(${binding.binding})`;
        switch (kind) {
            case 'texture':
            case 'sampler':
                return `${head} var ${name}: ${wgslType(binding.type)};`;
            case 'storage': {
                const mode = access ? `, ${access}` : '';
                return `${head} var<storage${mode}> ${name}: ${wgslType(binding.type)};`;
            }
            case 'uniform':
            default:
                return `${head} var<uniform> ${name}: ${wgslType(binding.type)};`;
        }
    }

    /** WGSL local binding. */
    declareLet(name: string, type: GpuType, value: string): string {
        return `let ${name}: ${wgslType(type)} = ${value};`;
    }

    /** WGSL value construction. */
    construct(type: GpuType, args: readonly string[]): string {
        return `${wgslType(type)}(${args.join(', ')})`;
    }

    /** WGSL conversion call. */
    cast(type: GpuType, value: string): string {
        return `${wgslType(type)}(${value})`;
    }

    /** WGSL texture sample. */
    sample(texture: string, sampler: string, coords: string): string {
        return `textureSample(${texture}, ${sampler}, ${coords})`;
    }

    /** WGSL scalar literal. */
    literal(_type: GpuType, value: string): string {
        return value;
    }

    /** WGSL numeric scalar formatting. */
    formatScalar(scalar: GpuScalar, value: number): string {
        return formatScalar(scalar, value);
    }

    /** WGSL struct declaration. */
    structDecl(type: StructType): string {
        const fields = type.fields
            .map((field) => `    ${field.name}: ${wgslType(field.type)},`)
            .join('\n');
        return `struct ${type.name} {\n${fields}\n}`;
    }

    /** WGSL loop, `body` is the text between the braces. */
    loop(body: string): string {
        return `loop {\n${body}}`;
    }

    /** WGSL discard. */
    discard(): string {
        return 'discard;';
    }

    /** WGSL break. */
    break(): string {
        return 'break;';
    }

    /** WGSL continue. */
    continue(): string {
        return 'continue;';
    }

    /** WGSL address space qualifier. */
    addressSpace(type: GpuType): string {
        if (type.kind === 'texture' || type.kind === 'sampler') return 'var';
        if (type.kind === 'array' && type.count === null) return 'var<storage>';
        return 'var<uniform>';
    }

    /** WGSL needs no header prefix. */
    preamblePrefix(): string {
        return '';
    }
}

/** Options accepted by {@link TestWgslBackend}. */
export type TestWgslBackendOptions = Omit<BaseBackendOptions, 'syntax'>;

/** WGSL backend used by tests. */
export class TestWgslBackend extends BaseBackend {
    constructor(options: TestWgslBackendOptions = {}) {
        super({
            ...options,
            syntax: new TestWgslSyntax(),
            name: options.name ?? 'wgsl',
            capabilities: { ...ALL_CAPABILITIES, ...(options.capabilities ?? {}) },
        });
    }
}

/** Create a test WGSL backend. */
export function createTestBackend(options: TestWgslBackendOptions = {}): TestWgslBackend {
    return new TestWgslBackend(options);
}

/**
 * WGSL target syntax for `murow/gpu`.
 *
 * `murow/gpu` is target-agnostic: it owns the IR, the walker, the schema and
 * the descriptors, but no language strings. This module supplies every WGSL
 * spelling the code generator needs, so WebGPU-specific output lives in this
 * backend package, not in the shared layer.
 */
import type {
    BindingKind,
    StorageAccess,
    TargetSyntax,
} from 'murow/gpu/codegen';
import type { IrBinding, IrEntry, IrOutput, IrStage } from 'murow/gpu/ir';
import type { GpuScalar, GpuType, StructType } from 'murow/gpu';

/** WGSL spelling of a type. Structs and bindings emit by name. */
export function wgslType(type: GpuType): string {
    if ((type as { atomic?: boolean }).atomic) {
        const scalar = type.kind === 'scalar' ? type.scalar : 'u32';
        return `atomic<${scalar}>`;
    }
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
            if (type.depth) return `texture_depth_${suffix}`;
            if (type.access !== 'sample') {
                return `texture_storage_${suffix}<${type.format ?? 'rgba8unorm'}, ${type.access}>`;
            }
            return `texture_${suffix}<${type.scalar}>`;
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

/** WGSL target syntax. */
export class WgslSyntax implements TargetSyntax {
    readonly name = 'wgsl';

    typeName(type: GpuType): string {
        return wgslType(type);
    }

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

    paramDecl(location: number, name: string, type: GpuType): string {
        return `@location(${location}) ${name}: ${wgslType(type)}`;
    }

    returnType(stage: IrStage, type: GpuType): string {
        if (stage === 'compute') return '';
        const spelling = wgslType(type);
        return stage === 'vertex'
            ? ` -> @builtin(position) ${spelling}`
            : ` -> @location(0) ${spelling}`;
    }

    entrySignature(
        entry: IrEntry,
        params: readonly string[],
        name: string,
        outputStruct?: string,
    ): string {
        const attribute = entry.stage === 'compute'
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
        const attribute = output.builtin !== undefined
            ? this.builtin(output.builtin)
            : `@location(${output.location ?? 0})`;
        return `${attribute} ${output.name}: ${wgslType(output.type)}`;
    }

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

    declareLet(name: string, type: GpuType, value: string): string {
        return `let ${name}: ${wgslType(type)} = ${value};`;
    }

    construct(type: GpuType, args: readonly string[]): string {
        return `${wgslType(type)}(${args.join(', ')})`;
    }

    cast(type: GpuType, value: string): string {
        return `${wgslType(type)}(${value})`;
    }

    sample(texture: string, sampler: string, coords: string): string {
        return `textureSample(${texture}, ${sampler}, ${coords})`;
    }

    literal(_type: GpuType, value: string): string {
        return value;
    }

    formatScalar(scalar: GpuScalar, value: number): string {
        return formatScalar(scalar, value);
    }

    structDecl(type: StructType): string {
        const fields = type.fields
            .map((field) => `    ${field.name}: ${wgslType(field.type)},`)
            .join('\n');
        return `struct ${type.name} {\n${fields}\n}`;
    }

    loop(body: string): string {
        return `loop {\n${body}}`;
    }

    discard(): string {
        return 'discard;';
    }

    break(): string {
        return 'break;';
    }

    continue(): string {
        return 'continue;';
    }

    addressSpace(type: GpuType): string {
        if (type.kind === 'texture' || type.kind === 'sampler') return 'var';
        if (type.kind === 'array' && type.count === null) return 'var<storage>';
        return 'var<uniform>';
    }

    preamblePrefix(): string {
        return '';
    }
}

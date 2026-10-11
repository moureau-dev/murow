/**
 * The target syntax seam.
 *
 * A backend supplies one {@link TargetSyntax} that owns every target-specific
 * string the walker needs. The shared walker in `backend.ts` stays
 * target-agnostic and never embeds a keyword, decoration, type spelling, or
 * literal suffix of its own.
 *
 * `BindingKind` and `StorageAccess` are semantic, not syntax: they classify a
 * bound resource and describe how it is accessed, independently of the target.
 */
import type { GpuScalar, GpuType, StructType } from '../types';
import type { IrBinding, IrEntry, IrOutput, IrStage } from '../ir/nodes';

/** How a bound resource is addressed in the emitted source. */
export type BindingKind = 'uniform' | 'storage' | 'texture' | 'sampler';

/** Access mode of a storage buffer. */
export type StorageAccess = 'read' | 'read_write';

/** Per-binding emission hint, matched by group and binding slot. */
export interface BindingHint {
    readonly group: number;
    readonly binding: number;
    readonly kind: BindingKind;
    readonly name?: string;
    readonly access?: StorageAccess;
}

/**
 * Every target-specific string the walker needs.
 *
 * Implementations provide one instance per target language. The walker calls
 * these methods; it never formats target syntax itself.
 */
export interface TargetSyntax {
    /** Target name, reported as the backend name when none is supplied. */
    readonly name: string;

    /** Spelling of a GPU type, structs emit by name. */
    typeName(type: GpuType): string;

    /** Attribute or decoration for a stage builtin. */
    builtin(name: string): string;

    /** Declaration of one entry input parameter. */
    paramDecl(location: number, name: string, type: GpuType): string;

    /** Return type suffix of an entry, empty when there is no return value. */
    returnType(stage: IrStage, type: GpuType): string;

    /**
     * Attributes plus the function head for an entry, for example
     * `@fragment\nfn fs_main(...)`. The return type is appended separately via
     * {@link TargetSyntax.returnType}, unless `outputStruct` is given, in which
     * case the head ends with `-> <outputStruct>`.
     */
    entrySignature(
        entry: IrEntry,
        params: readonly string[],
        name: string,
        outputStruct?: string,
    ): string;

    /** Name of the vertex output struct. */
    outputStructName(entry: IrEntry): string;

    /** Declaration of a vertex output struct. */
    outputStructDecl(entry: IrEntry): string;

    /** One field of a vertex output struct, without a trailing separator. */
    outputField(output: IrOutput): string;

    /** Declaration of a bound resource, given its resolved role. */
    declareBinding(
        binding: IrBinding,
        kind: BindingKind,
        access: StorageAccess | undefined,
        name: string,
    ): string;

    /** Declaration of a local `let` binding. */
    declareLet(name: string, type: GpuType, value: string): string;

    /** Construction of a value from already-emitted argument strings. */
    construct(type: GpuType, args: readonly string[]): string;

    /** Conversion of a value to a type. */
    cast(type: GpuType, value: string): string;

    /** Sample of a texture with a sampler and coordinates. */
    sample(texture: string, sampler: string, coords: string): string;

    /** A scalar or boolean literal, given its already-formatted text. */
    literal(type: GpuType, value: string): string;

    /** Formatting of a numeric scalar value, for example `1.0`, `1u`, `1`. */
    formatScalar(scalar: GpuScalar, value: number): string;

    /** Declaration of a struct type. */
    structDecl(type: StructType): string;

    /**
     * A loop statement. `body` is the text between the braces, including any
     * trailing indentation of the closing brace.
     */
    loop(body: string): string;

    /** Discard statement. */
    discard(): string;

    /** Break statement. */
    break(): string;

    /** Continue statement. */
    continue(): string;

    /** Address space qualifier a binding's type lives in. */
    addressSpace(type: GpuType): string;

    /** Header text emitted before everything else, empty when not needed. */
    preamblePrefix(): string;
}

/**
 * Bind group layouts as plain data.
 *
 * A layout is a named list of bindings. Each binding carries a name, a binding
 * number, a resource kind, an optional GPU value type, and per-stage
 * visibility. Lookups use array scans; no `Map`.
 */

import type { GpuType } from '../types';

/** Resource kind of a binding. */
export type BindingType = 'uniform' | 'storage' | 'readonly-storage' | 'texture' | 'sampler';

/** Shader stages a binding is visible to. */
export interface BindingVisibility {
    readonly vertex: boolean;
    readonly fragment: boolean;
    readonly compute: boolean;
}

/** One binding within a layout. */
export interface BindingEntry {
    readonly name: string;
    readonly binding: number;
    readonly type: BindingType;
    /** GPU value type, when the binding carries typed data. */
    readonly gpuType?: GpuType;
    readonly visibility: BindingVisibility;
}

/** Visibility that includes no stage. */
export const NO_STAGES: BindingVisibility = Object.freeze({ vertex: false, fragment: false, compute: false });

/** Visibility that includes every stage. */
export const ALL_STAGES: BindingVisibility = Object.freeze({ vertex: true, fragment: true, compute: true });

/** Options accepted by {@link BindingEntry} construction. */
export interface BindingEntryOptions {
    readonly name: string;
    readonly binding: number;
    readonly type: BindingType;
    readonly gpuType?: GpuType;
    readonly visibility?: Partial<BindingVisibility>;
}

/** Normalize partial visibility to all three flags. */
export function visibility(options: Partial<BindingVisibility> = {}): BindingVisibility {
    return {
        vertex: options.vertex ?? false,
        fragment: options.fragment ?? false,
        compute: options.compute ?? false,
    };
}

/** Build a binding entry with normalized visibility. */
export function binding(options: BindingEntryOptions): BindingEntry {
    return {
        name: options.name,
        binding: options.binding,
        type: options.type,
        gpuType: options.gpuType,
        visibility: visibility(options.visibility),
    };
}

/** Options for {@link BindGroupLayout}. */
export interface BindGroupLayoutOptions {
    /** Optional name, used by backends for labels or cache keys. */
    readonly name?: string;
    readonly entries: readonly BindingEntry[];
}

/**
 * A bind group layout. Construction validates that binding numbers and names
 * are unique. `get(name)` and `getByBinding(number)` scan the entries array.
 */
export class BindGroupLayout {
    readonly name: string | undefined;
    readonly entries: readonly BindingEntry[];
    /** Dense index from binding number to entry, built once. */
    private readonly byBinding: readonly (BindingEntry | undefined)[];

    constructor(options: BindGroupLayoutOptions) {
        this.name = options.name;
        this.entries = options.entries ?? [];
        this.byBinding = buildBindingIndex(this.entries);
        validateBindGroupLayout(this);
    }

    /** Number of entries. */
    get size(): number {
        return this.entries.length;
    }

    /** Find an entry by name. */
    get(name: string): BindingEntry | undefined {
        for (const entry of this.entries) {
            if (entry.name === name) return entry;
        }
        return undefined;
    }

    /** Find an entry by binding number. */
    getByBinding(binding: number): BindingEntry | undefined {
        return this.byBinding[binding];
    }

    /** Whether an entry with the name exists. */
    has(name: string): boolean {
        return this.get(name) !== undefined;
    }

    /** Binding number for a name, or undefined. */
    bindingOf(name: string): number | undefined {
        return this.get(name)?.binding;
    }

    /** Return a copy of this layout with a name set. */
    withName(name: string): BindGroupLayout {
        return new BindGroupLayout({ name, entries: this.entries });
    }
}

/** Throw when a layout has duplicate names or binding numbers, or invalid numbers. */
export function validateBindGroupLayout(layout: BindGroupLayout): void {
    const bindings = new Set<number>();
    const names = new Set<string>();
    for (const entry of layout.entries) {
        if (!Number.isInteger(entry.binding) || entry.binding < 0) {
            throw new Error(`BindGroupLayout: invalid binding number ${entry.binding} for '${entry.name}'`);
        }
        if (bindings.has(entry.binding)) {
            throw new Error(`BindGroupLayout: duplicate binding number ${entry.binding}`);
        }
        if (names.has(entry.name)) {
            throw new Error(`BindGroupLayout: duplicate binding name '${entry.name}'`);
        }
        bindings.add(entry.binding);
        names.add(entry.name);
    }
}

function buildBindingIndex(entries: readonly BindingEntry[]): readonly (BindingEntry | undefined)[] {
    let max = -1;
    for (const entry of entries) {
        if (Number.isInteger(entry.binding) && entry.binding > max) max = entry.binding;
    }
    const index: (BindingEntry | undefined)[] = new Array(max + 1);
    for (const entry of entries) {
        if (Number.isInteger(entry.binding) && entry.binding >= 0) index[entry.binding] = entry;
    }
    return index;
}

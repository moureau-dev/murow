/**
 * Name-as-id registries for code generation.
 *
 * A registry keeps a dense array of named entries plus a derived name to slot
 * index. Lookups index the array directly. No `Map`.
 */
import type { IrExpr, IrStmt } from '../ir/nodes';
import type { EmitContext } from './backend';

/** Emitter for one IR node. */
export type NodeImpl = (node: IrExpr | IrStmt, ctx: EmitContext) => string;

/** Emitter for one intrinsic call. */
export type IntrinsicImpl = (args: IrExpr[], ctx: EmitContext) => string;

/** One named entry in a registry. */
export interface RegistryEntry<T> {
    readonly name: string;
    readonly fn: T;
}

/** Options accepted by a registry constructor. */
export interface RegistryOptions<T> {
    readonly entries?: readonly RegistryEntry<T>[];
}

/**
 * Dense name to implementation table. Registration appends; a derived record
 * maps a name to its slot. Overriding replaces in place.
 */
export class NameIdRegistry<T> {
    private readonly entries: RegistryEntry<T>[] = [];
    private readonly slots: Record<string, number> = Object.create(null);

    constructor(options: RegistryOptions<T> = {}) {
        for (const entry of options.entries ?? []) this.register(entry.name, entry.fn);
    }

    /** Number of registered entries. */
    get size(): number {
        return this.entries.length;
    }

    /** Add a new entry. Throws when the name is already registered. */
    register(name: string, fn: T): void {
        if (name in this.slots) {
            throw new Error(`NameIdRegistry: '${name}' is already registered`);
        }
        this.slots[name] = this.entries.length;
        this.entries.push({ name, fn });
    }

    /** Replace an entry, or register it when absent. */
    override(name: string, fn: T): void {
        const slot = this.slots[name];
        if (slot === undefined) {
            this.register(name, fn);
            return;
        }
        this.entries[slot] = { name, fn };
    }

    /** Implementation for a name, or undefined. */
    get(name: string): T | undefined {
        const slot = this.slots[name];
        return slot === undefined ? undefined : this.entries[slot].fn;
    }

    /** Whole entry for a name, or undefined. */
    getEntry(name: string): RegistryEntry<T> | undefined {
        const slot = this.slots[name];
        return slot === undefined ? undefined : this.entries[slot];
    }

    /** Whether a name is registered. */
    has(name: string): boolean {
        return name in this.slots;
    }

    /** Registered names in registration order. */
    names(): string[] {
        return this.entries.map((entry) => entry.name);
    }
}

/** Registry of node emitters, keyed by IR node kind. */
export class NodeRegistry extends NameIdRegistry<NodeImpl> {}

/** Registry of intrinsic call emitters, keyed by intrinsic name. */
export class IntrinsicRegistry extends NameIdRegistry<IntrinsicImpl> {}

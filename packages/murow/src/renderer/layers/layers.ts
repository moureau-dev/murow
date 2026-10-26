/**
 * Render layers: a small registry that maps names to bit values.
 *
 * A layer is one bit on an object; a camera holds a mask of the bits it sees.
 * The registry is setup-time only. Per-frame code uses plain numbers and
 * {@link visibleTo}, never the registry.
 */

/** A single layer bit, a power of two. */
export type LayerBit = number;

/** A bit mask of one or more layers. */
export type LayerMask = number;

/** A layer reference accepted at authoring time. */
export type LayerInput = LayerBit | string;

/** Hard ceiling for the 32-bit layer mask. */
export const MAX_LAYERS = 32;

/** Every bit, including layers defined later. */
export const ALL_LAYERS: LayerMask = 0xffffffff;

/** Options for {@link LayerRegistry}. */
export interface LayerRegistryOptions {
    /** Number of bits available. Default 32, maximum 32. */
    capacity?: number;
    /** Name of the layer at bit 0. Default `'default'`. */
    defaultLayer?: string;
}

/**
 * Name-to-bit registry for render layers.
 *
 * The default layer is defined at bit 0, so objects spawned without a layer
 * always have a non-zero bit. Bit 0 can never be used as a "no layer" value.
 */
export class LayerRegistry {
    /** Number of bits available. */
    readonly capacity: number;
    /** Name of the layer assigned to bit 0. */
    readonly defaultName: string;

    private readonly byName = new Map<string, LayerBit>();
    private readonly names: string[] = [];
    private nextIndex = 0;
    private defined = 0;

    constructor(options: LayerRegistryOptions = {}) {
        const capacity = options.capacity ?? MAX_LAYERS;
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_LAYERS) {
            throw new Error(`LayerRegistry: capacity must be an integer from 1 to ${MAX_LAYERS} (got ${capacity})`);
        }
        this.capacity = capacity;
        const defaultName = options.defaultLayer ?? 'default';
        if (defaultName.length === 0) {
            throw new Error('LayerRegistry: defaultLayer must be a non-empty name');
        }
        this.defaultName = defaultName;
        this.define(defaultName);
    }

    /** Number of defined layers. */
    get size(): number {
        return this.names.length;
    }

    /** Bit for the default layer. */
    get defaultBit(): LayerBit {
        return this.byName.get(this.defaultName)!;
    }

    /** Every bit, including layers defined after this read. */
    get all(): LayerMask {
        return ALL_LAYERS;
    }

    /** OR of every layer defined so far. */
    get definedMask(): LayerMask {
        return this.defined;
    }

    /**
     * Define a layer and return its bit. Calling this again with the same name
     * returns the existing bit.
     */
    define(name: string): LayerBit {
        if (name.length === 0) throw new Error('LayerRegistry: layer name must not be empty');
        const existing = this.byName.get(name);
        if (existing !== undefined) return existing;
        if (this.nextIndex >= this.capacity) {
            throw new Error(`LayerRegistry: capacity of ${this.capacity} layers reached`);
        }
        const bit = (1 << this.nextIndex) >>> 0;
        this.nextIndex += 1;
        this.byName.set(name, bit);
        this.names.push(name);
        this.defined = (this.defined | bit) >>> 0;
        return bit;
    }

    /** True when the name is defined. */
    has(name: string): boolean {
        return this.byName.has(name);
    }

    /** Bit for a name, or `undefined` when it is not defined. */
    bit(name: string): LayerBit | undefined {
        return this.byName.get(name);
    }

    /** OR of the named layers. Throws when a name is not defined. */
    mask(...names: string[]): LayerMask {
        let mask = 0;
        for (const name of names) {
            const bit = this.byName.get(name);
            if (bit === undefined) throw new Error(`LayerRegistry: unknown layer '${name}'`);
            mask |= bit;
        }
        return mask >>> 0;
    }

    /**
     * Resolve a name or bit to a bit. `undefined` returns the default bit.
     * A numeric input must be a single bit.
     */
    resolveLayer(input?: LayerInput): LayerBit {
        if (input === undefined) return this.defaultBit;
        if (typeof input === 'number') {
            const bit = input >>> 0;
            if (bit === 0 || (bit & (bit - 1)) !== 0) {
                throw new Error(`LayerRegistry: ${input} is not a single layer bit`);
            }
            return bit;
        }
        const bit = this.byName.get(input);
        if (bit === undefined) throw new Error(`LayerRegistry: unknown layer '${input}'`);
        return bit;
    }

    /**
     * Resolve a mask from a number, a name, or a list of names. `undefined`
     * returns {@link all}.
     */
    resolveMask(input?: LayerMask | string | readonly string[]): LayerMask {
        if (input === undefined) return ALL_LAYERS;
        if (typeof input === 'number') return input >>> 0;
        if (typeof input === 'string') return this.mask(input);
        let mask = 0;
        for (const name of input) mask |= this.mask(name);
        return mask >>> 0;
    }

    /** Name for a bit, or `undefined` when the bit is not defined. */
    nameOf(bit: LayerBit): string | undefined {
        for (const [name, value] of this.byName) {
            if (value === bit) return name;
        }
        return undefined;
    }

    /** Every defined layer as `[name, bit]`, in definition order. */
    entries(): ReadonlyArray<readonly [name: string, bit: LayerBit]> {
        return this.names.map((name) => [name, this.byName.get(name)!] as const);
    }

    /** Reset the registry to only the default layer. Intended for tests. */
    clear(): void {
        this.byName.clear();
        this.names.length = 0;
        this.nextIndex = 0;
        this.defined = 0;
        this.define(this.defaultName);
    }
}

/**
 * Resolve an object's render layer: the instance value wins, then the prefab
 * layer, then the registry default.
 */
export function resolveRenderLayer(
    layers: LayerRegistry,
    instance?: LayerInput,
    prefab?: string,
): LayerBit {
    return layers.resolveLayer(instance ?? prefab);
}

/** True when `layer` is included in `mask`. */
export function visibleTo(layer: LayerBit, mask: LayerMask): boolean {
    return (layer & mask) !== 0;
}

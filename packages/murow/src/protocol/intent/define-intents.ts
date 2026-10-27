import type { Schema } from '../../core/binary-codec';
import { defineIntent } from './define-intent';
import { IntentRegistry } from './intent-registry';

/**
 * User-supplied schema map for `defineIntents`. Each entry maps an intent name
 * to a field schema. The reserved `kind` and `tick` fields are added
 * automatically when the wire packet is built.
 */
export type IntentSchemaMap = Record<string, Record<string, any>>;

/** Payload type for a named intent, inferred from its schema. */
export type IntentPayload<I extends IntentSchemaMap, K extends keyof I> = {
    [P in keyof I[K]]: I[K][P] extends { read(dv: DataView, o: number): infer R }
        ? R
        : never;
};

/** Result of `defineIntents`. */
export interface DefinedIntents<I extends IntentSchemaMap> {
    /** Underlying `DefinedIntent` objects keyed by name. */
    readonly defs: { readonly [K in keyof I]: ReturnType<typeof defineIntent<number, I[K]>> };
    /** Intent name to numeric kind. */
    readonly kindByName: { readonly [K in keyof I]: number };
    /** Numeric kind back to intent name. */
    readonly nameByKind: Readonly<Record<number, keyof I & string>>;
    /** Pre-populated registry ready to plug into the network layer. */
    readonly registry: IntentRegistry;
    /** Phantom field for type inference, never read at runtime. */
    readonly __payloads: { [K in keyof I]: IntentPayload<I, K> };
}

/**
 * Declare every intent the game uses in one map. Numeric kinds are assigned in
 * insertion order starting at 1 (0 is reserved for engine control frames).
 */
export function defineIntents<I extends IntentSchemaMap>(intents: I): DefinedIntents<I> {
    const defs: any = {};
    const kindByName: any = {};
    const nameByKind: Record<number, keyof I & string> = {};
    const registry = new IntentRegistry();

    let nextKind = 1;

    for (const name of Object.keys(intents) as (keyof I & string)[]) {
        const kind = nextKind++;
        const def = defineIntent({
            kind,
            schema: intents[name] as Schema<any>,
        });
        defs[name] = def;
        kindByName[name] = kind;
        nameByKind[kind] = name;
        registry.register(def);
    }

    return {
        defs,
        kindByName,
        nameByKind,
        registry,
        __payloads: undefined as any,
    };
}

import { IntentRegistry, defineIntent } from 'murow/protocol';
import type { Schema } from "murow/core/binary-codec";

/**
 * User-supplied schema map for `defineIntents`. Each entry maps an
 * intent name to a field schema. The reserved `kind` and `tick` fields
 * are added automatically when the wire packet is built; users only
 * declare payload fields.
 */
export type IntentSchemaMap = Record<string, Record<string, any>>;

/** Payload type for a named intent, inferred from its schema. */
export type IntentPayload<I extends IntentSchemaMap, K extends keyof I> = {
    [P in keyof I[K]]: I[K][P] extends { read(dv: DataView, o: number): infer R }
        ? R
        : never;
};

/**
 * Result of `defineIntents`. `registry` plugs into `GameServer` and
 * `GameClient` via the `protocol` option; `__payloads` is a phantom used
 * purely for type inference at `sendIntent` call sites.
 */
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
 * Declare every intent the game uses in one map. Numeric kinds are
 * auto-assigned in insertion order starting at 1 (0 is reserved for
 * engine control frames).
 *
 * @example
 * const intents = defineIntents({
 *   move:  { dx: f32, dy: f32 },
 *   jump:  {},
 *   shoot: { from: vec2_le, dir: vec2_le },
 * });
 *
 * client.sendIntent('move', { dx: 1, dy: 0 });
 * server.on('intent', ({ name, payload }) => { ... });
 */
export function defineIntents<I extends IntentSchemaMap>(intents: I): DefinedIntents<I> {
    const defs: any = {};
    const kindByName: any = {};
    const nameByKind: Record<number, keyof I & string> = {};
    const registry = new IntentRegistry();

    let nextKind = 1; // kind 0 reserved for engine control

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

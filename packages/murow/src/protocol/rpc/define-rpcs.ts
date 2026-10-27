import { defineRPC } from './define-rpc';
import { RpcRegistry } from './rpc-registry';

/**
 * User-supplied schema map for `defineRpcs`. Each entry maps an RPC method name
 * to its field schema.
 */
export type RpcSchemaMap = Record<string, Record<string, any>>;

/** Payload type for a named RPC, inferred from its schema. */
export type RpcPayload<R extends RpcSchemaMap, K extends keyof R> = {
    [P in keyof R[K]]: R[K][P] extends { read(dv: DataView, o: number): infer T }
        ? T
        : never;
};

/** Result of `defineRpcs`. */
export interface DefinedRpcs<R extends RpcSchemaMap> {
    /** Underlying `DefinedRPC` objects keyed by method name. */
    readonly defs: { readonly [K in keyof R]: ReturnType<typeof defineRPC<R[K]>> };
    /** Pre-populated registry ready to plug into the network layer. */
    readonly registry: RpcRegistry;
    /** Phantom field for type inference, never read at runtime. */
    readonly __payloads: { [K in keyof R]: RpcPayload<R, K> };
}

/**
 * Declare every RPC the game uses in one map. RPCs are bidirectional; the same
 * registry serves server and client send/receive paths.
 */
export function defineRpcs<R extends RpcSchemaMap>(rpcs: R): DefinedRpcs<R> {
    const defs: any = {};
    const registry = new RpcRegistry();

    for (const method of Object.keys(rpcs) as (keyof R & string)[]) {
        const def = defineRPC({ method, schema: rpcs[method] });
        defs[method] = def;
        registry.register(def);
    }

    return {
        defs,
        registry,
        __payloads: undefined as any,
    };
}

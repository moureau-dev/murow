/**
 * A versioned protocol: intents, RPCs, custom messages, and one fingerprint
 * over all of them. Server and client pass the same object.
 */

import { defineIntents, type DefinedIntents, type IntentSchemaMap } from './intent/define-intents';
import { defineRpcs, type DefinedRpcs, type RpcSchemaMap } from './rpc/define-rpcs';
import {
    defineSnapshots,
    type DefinedSnapshots,
    type SnapshotEntry,
    type SnapshotSchemaMap,
} from './messages/define-snapshots';

/** Input to {@link defineProtocol}. */
export interface ProtocolSpec<
    I extends IntentSchemaMap,
    R extends RpcSchemaMap,
    M extends SnapshotSchemaMap,
> {
    /** Wire protocol revision. Default 1. */
    readonly version?: number;
    readonly intents: I;
    readonly rpcs: R;
    readonly messages?: M;
}

/** A defined, versioned protocol. */
export interface Protocol<
    I extends IntentSchemaMap = IntentSchemaMap,
    R extends RpcSchemaMap = RpcSchemaMap,
    M extends SnapshotSchemaMap = SnapshotSchemaMap,
> {
    readonly version: number;
    readonly intents: DefinedIntents<I>;
    readonly rpcs: DefinedRpcs<R>;
    readonly messages: DefinedSnapshots<M> | undefined;
    /** Stable fingerprint over version and every schema. */
    readonly fingerprint: string;
}

/**
 * Define the protocol once and pass it to both `GameServer` and `GameClient`.
 *
 * ```ts
 * const protocol = defineProtocol({
 *   version: 1,
 *   intents: { move: { dx: f32, dz: f32 } },
 *   rpcs: { buy: { item: u16 } },
 *   messages: { chat: { text: string } },
 * });
 * ```
 */
export function defineProtocol<
    I extends IntentSchemaMap,
    R extends RpcSchemaMap,
    M extends SnapshotSchemaMap = SnapshotSchemaMap,
>(spec: ProtocolSpec<I, R, M>): Protocol<I, R, M> {
    const version = spec.version ?? 1;
    if (!Number.isInteger(version) || version < 1) {
        throw new Error(`defineProtocol: version must be a positive integer (got ${version})`);
    }

    return {
        version,
        intents: defineIntents(spec.intents),
        rpcs: defineRpcs(spec.rpcs),
        messages: spec.messages === undefined ? undefined : defineSnapshots(spec.messages),
        fingerprint: protocolFingerprint(version, spec.intents, spec.rpcs, spec.messages),
    };
}

function schemaKey(schema: Record<string, any>): string {
    const parts: string[] = [];
    for (const name of Object.keys(schema)) {
        const field = schema[name];
        parts.push(`${name}:${fieldKey(field)}`);
    }
    return parts.join(',');
}

function fieldKey(field: any): string {
    const itemSchema = field?.__itemSchema as Record<string, any> | undefined;
    if (itemSchema !== undefined) return `array<${schemaKey(itemSchema)}>`;
    return String(field?.size ?? '?');
}

function messageKey(entry: SnapshotEntry): string {
    if (typeof entry === 'object' && entry !== null && '__baseline' in entry) {
        return `baseline<${schemaKey(entry.__baseline as Record<string, any>)}>`;
    }
    return schemaKey(entry as Record<string, any>);
}

function mapKey(map: Record<string, any>): string {
    return Object.keys(map)
        .map((name) => `${name}{${messageKey(map[name] as SnapshotEntry)}}`)
        .join(';');
}

function protocolFingerprint(
    version: number,
    intents: IntentSchemaMap,
    rpcs: RpcSchemaMap,
    messages: SnapshotSchemaMap | undefined,
): string {
    const parts = [
        `v=${version}`,
        `i=${mapKey(intents)}`,
        `r=${mapKey(rpcs)}`,
        `m=${messages === undefined ? '' : mapKey(messages)}`,
    ];
    return fnv1a(parts.join('|'));
}

/** 32-bit FNV-1a as 8 hex chars. */
function fnv1a(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

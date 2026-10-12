import type { Component } from 'murow/ecs';

/**
 * A stable fingerprint of a set of synced components: names, field names and
 * wire widths, and the `networked()` spec (rate / interest / interp /
 * quantize). Server and client compute the same string for the same schema;
 * a mismatch means the two ends disagree about the wire layout.
 */
export function computeSchemaFingerprint(components: readonly Component<any>[]): string {
    const parts: string[] = [];
    for (const c of components) {
        const sync = (c as any).__sync as
            | {
                  rate?: unknown;
                  interest?: unknown;
                  interp?: unknown;
                  quantize?: Record<string, { min: number; max: number; bits?: number }>;
              }
            | undefined;
        const fields = (c.fieldNames as string[]).map(
            (f) => `${f}:${(c.schema as any)[f].size}`,
        );
        let q = '';
        if (sync?.quantize) {
            q = Object.keys(sync.quantize)
                .sort()
                .map((k) => {
                    const s = sync.quantize![k]!;
                    return `${k}:${s.min}:${s.max}:${s.bits ?? 16}`;
                })
                .join(',');
        }
        const rate = typeof sync?.rate === 'object' ? JSON.stringify(sync?.rate) : String(sync?.rate);
        parts.push(`${c.name}[${fields.join(',')}]r=${rate}i=${sync?.interest}p=${sync?.interp ?? ''}q=${q}`);
    }
    parts.sort();
    return fnv1a(parts.join('|'));
}

/** 32-bit FNV-1a over the string, as 8 hex chars. */
function fnv1a(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

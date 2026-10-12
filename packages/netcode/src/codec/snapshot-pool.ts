type Values = Record<string, number>;
type Row = (Values | null)[];

/** Acquire side of the snapshot value pool (what `decodeDelta` needs). */
export interface SnapshotValuePool {
    acquireMap(): Map<number, Row>;
    acquireRow(componentCount: number): Row;
    acquireValues(): Values;
}

/**
 * Recycles a snapshot's value storage so decode stops allocating once the
 * working set is warm: the `valuesByServerEntity` Map, its per-entity row
 * arrays, and the per-component value objects.
 *
 * Release is driven by the interpolation `Timeline`'s `onEvict`, so storage is
 * only returned once no live snapshot references it. The Timeline evicts in
 * tick order, which is what keeps this safe under out-of-order arrival: a
 * snapshot still in history is never recycled.
 *
 * Reused value objects may carry stale keys from a prior component; callers
 * read only the field names of the component at hand, so extras are ignored.
 */
export class SnapshotPool implements SnapshotValuePool {
    private readonly maps: Map<number, Row>[] = [];
    private readonly rows: Row[] = [];
    private readonly values: Values[] = [];

    acquireMap(): Map<number, Row> {
        const m = this.maps.pop();
        if (m === undefined) return new Map();
        m.clear();
        return m;
    }

    acquireRow(componentCount: number): Row {
        const r = this.rows.pop();
        if (r === undefined) return new Array<Values | null>(componentCount).fill(null);
        if (r.length !== componentCount) r.length = componentCount;
        for (let i = 0; i < componentCount; i++) r[i] = null;
        return r;
    }

    acquireValues(): Values {
        return this.values.pop() ?? {};
    }

    /** Return a snapshot's whole value structure for reuse. */
    release(map: Map<number, Row>): void {
        map.forEach((row) => {
            for (let i = 0; i < row.length; i++) {
                const v = row[i];
                if (v !== null) {
                    this.values.push(v);
                    row[i] = null;
                }
            }
            this.rows.push(row);
        });
        map.clear();
        this.maps.push(map);
    }
}

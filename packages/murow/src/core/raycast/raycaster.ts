import type { Ray3D } from '../ray/ray-3d';
import type { Hitbox } from '../hitbox/hitbox';
import { testHitbox3D } from '../hitbox/test';
import { HitBuffer, type BufferedHit } from './hit-buffer';

/** Per-axis column accessors. Each returns the field arrays for a frame's worth of entities. */
interface Transform3D {
    position: () => { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> };
    scale: () => { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> };
}

interface Lookup {
    /** Candidate ids to test this cast (e.g. an ECS query result). */
    query: () => readonly number[];
    /** Resolve an id to its hitbox, or `null` to skip it. */
    hitbox: (id: number) => Hitbox<'3d'> | null;
}

type Hit = BufferedHit<number, [number, number, number]>;

interface QueryOptions {
    filter?: (id: number) => boolean;
    maxDistance?: number;
}

/**
 * Raycaster — casts a ray against a set of entities and ranks the hits.
 *
 * Source-agnostic: `lookup` supplies the candidate ids and their hitboxes,
 * `configure` supplies how to read each id's transform. Both carry all
 * world knowledge as closures, so the raycaster depends on neither an ECS
 * nor a renderer. Owns a reused hit buffer; `cast` is allocation-free per
 * entity. The same instance can be exported from shared code and wired to
 * a sim world on the server and a render world on the client.
 */
export class Raycaster {
    private buf = new HitBuffer<number, [number, number, number]>(3);
    private resultBuffer: Hit[] = [];
    private _lookup: Lookup | null = null;
    private _transform: Transform3D | null = null;

    /** Wire the candidate source: which ids to test and how to resolve each id's hitbox. */
    lookup(lookup: Lookup): this {
        this._lookup = lookup;
        return this;
    }

    /** Wire the transform source: how to read each id's position and scale. */
    configure(transform: Transform3D): this {
        this._transform = transform;
        return this;
    }

    /** Cast `ray` against the configured source, populating the hit buffer. Chains to `hit`/`hitAll`. */
    cast(ray: Ray3D): this {
        if (!this._lookup || !this._transform) {
            throw new Error('Raycaster.cast: call lookup() and configure() first');
        }
        this.buf.reset();

        const hitbox = this._lookup.hitbox;
        const ids = this._lookup.query();
        const pos = this._transform.position();
        const scale = this._transform.scale();

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const hb = hitbox(id);
            if (hb === null) continue;
            const hit = testHitbox3D(
                ray, hb,
                pos.x[id], pos.y[id], pos.z[id],
                scale.x[id], scale.y[id], scale.z[id],
            );
            if (hit) this.buf.push(id, hit.distance, hit.point[0], hit.point[1], hit.point[2], hit.distance, hit.part);
        }
        return this;
    }

    /** Nearest hit, or null. Pool-backed; valid until the next cast. */
    hit(opts?: QueryOptions): Hit | null {
        return this.buf.nearest(opts?.filter, opts?.maxDistance ?? Infinity);
    }

    /** All hits, nearest first. Reused array; do not retain across casts. */
    hitAll(opts?: QueryOptions): readonly Hit[] {
        this.buf.collectInto(this.resultBuffer, opts?.filter, opts?.maxDistance ?? Infinity);
        return this.resultBuffer;
    }
}

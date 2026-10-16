/**
 * - `lerp`  linear (positions, scalars)
 * - `slerp` spherical (quaternions)
 * - `step`  hold older value until t >= 0.5, then snap (enums, ids)
 * - `none`  always newest (strings, references)
 */
export type InterpolationMode = 'lerp' | 'slerp' | 'step' | 'none';

/**
 * - `every-tick`  shipped every snapshot tick
 * - `on-change`   shipped only when a field changed
 * - `{ every: N }` every N ticks regardless
 */
export type SyncRate = 'every-tick' | 'on-change' | { every: number };

/** `T | (string & {})`: accept any string at runtime, autocomplete the known literals. */
export type StringOr<T extends string> = T | (string & {});

/** `'global'` or a plugin name (e.g. an `AoiGrid` instance's `name`). */
export type InterestName = StringOr<'global'>;

/**
 * Visibility filter for a component:
 * - `'global'` never filters (and forces its entity into the snapshot).
 * - a plugin name ships the component only when that plugin deems the entity
 *   visible.
 * - `{ all: [...] }` ships only when every named source admits the entity.
 * - `{ any: [...] }` ships when at least one named source admits it.
 * `'global'` inside a list always admits; an unknown name admits (unfiltered).
 */
export type InterestRule =
    | InterestName
    | { all: readonly InterestName[] }
    | { any: readonly InterestName[] };

/** Canonical string for an interest rule, for schema fingerprints. */
export function interestKey(rule: InterestRule): string {
    if (typeof rule === 'string') return rule;
    if ('all' in rule) return `all:${[...rule.all].sort().join(',')}`;
    return `any:${[...rule.any].sort().join(',')}`;
}

export interface SyncSpec {
    /** Snapshot eligibility cadence. */
    rate: SyncRate;
    /**
     * Visibility filter. `'global'` is never filtered (and forces its entity
     * into the snapshot). A plugin name (e.g. an `AoiGrid`'s `name`) means the
     * component ships to a peer only if that plugin deems the entity visible.
     */
    interest: InterestRule;
    /**
     * Interpolation mode for this component's fields. `slerp` treats the
     * component as a quaternion (`x`/`y`/`z`/`w`, or exactly four fields in
     * declaration order) and interpolates along the shortest arc; anything else
     * falls back to `lerp`.
     */
    interp?: InterpolationMode;
    /**
     * Reconciliation dead-zone for this component. A server correction whose
     * per-field magnitude is at or below this keeps the predicted value
     * (smooth) instead of snapping.
     */
    snapThreshold?: number;
    /**
     * Per-field wire quantization. Each listed field is sent as a `bits`-wide
     * unsigned integer over `[min, max]` instead of its full schema width
     * (e.g. a position `f32` at `bits: 16` costs 2 bytes on the wire while the
     * store stays `f32`). Out-of-range values clamp. Default `bits: 16`.
     */
    quantize?: Record<string, { min: number; max: number; bits?: 8 | 16 }>;
}

/**
 * Identity helper that gives full TypeScript checking on the `sync` block
 * of a `defineComponent` call. Plain object literals also work, but the
 * function call site catches typos (`'evry-tick'`, `interest: 42`) at
 * compile time and provides autocomplete on the union members.
 *
 * @example
 * import { defineComponent, f32 } from 'murow';
 * import { networked } from 'murow/netcode';
 *
 * const Position = defineComponent('Position', {
 *   schema: { x: f32, y: f32 },
 *   sync: networked({ rate: 'every-tick', interest: 'aoi', interp: 'lerp' }),
 * });
 */
export function networked(spec: SyncSpec): SyncSpec {
    return spec;
}

/**
 * Whether a component's value rides along in the snapshot for the given
 * tick. `every-tick` always; `on-change` only when the field changed
 * since the last snapshot; `{ every: N }` on every Nth tick or on change.
 */
export function rateIncludes(rate: SyncRate, dirty: boolean, tick: number): boolean {
    if (rate === 'every-tick') return true;
    if (rate === 'on-change') return dirty;
    return dirty || (rate.every > 0 && tick % rate.every === 0);
}

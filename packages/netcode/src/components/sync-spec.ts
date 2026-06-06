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

/** `'global'` or a plugin name (e.g. an `AoiGrid` instance's `name`). */
export type InterestRule = 'global' | (string & {});

export interface SyncSpec {
    /** Snapshot eligibility cadence. */
    rate: SyncRate;
    /** Visibility filter (e.g. AOI plugin name) or `'global'`. */
    interest: InterestRule;
    /** Default interpolation mode for this component's fields. */
    interp?: InterpolationMode;
    /** Override the reconciliation snap threshold for this component. */
    snapThreshold?: number;
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

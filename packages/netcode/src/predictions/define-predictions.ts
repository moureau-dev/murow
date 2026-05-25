import type { DefinedIntents, IntentPayload, IntentSchemaMap } from '../intents/define-intents';
import type { PredictionContext } from '../ctx';

/**
 * A single prediction function. Pure deterministic logic that mutates
 * `ctx.world` given a typed intent payload. The same function runs on
 * the server as the authoritative apply and on the client as the
 * predicted apply (plus rollback replay during reconciliation).
 */
export type PredictionFn<P> = (payload: P, ctx: PredictionContext) => void;

/**
 * Bundle of predictions keyed by intent name. Partial: not every intent
 * needs a prediction. Intents without an entry here are server-only and
 * should register through `defineHandlers` instead.
 */
export type PredictionMap<I extends IntentSchemaMap> = {
    [K in keyof I]?: PredictionFn<IntentPayload<I, K>>;
};

/**
 * Tagged bundle returned by `definePredictions`. Pass to both
 * `server.use(predictions)` and `client.use(predictions)`.
 */
export interface DefinedPredictions<I extends IntentSchemaMap> {
    readonly __kind: 'predictions';
    readonly intents: DefinedIntents<I>;
    readonly map: PredictionMap<I>;
}

/**
 * Bundle predictions for an intent schema. The same module is used on
 * both sides; the server applies authoritatively, the client predicts
 * locally and rolls back on disagreement.
 *
 * Predictions must be deterministic: no `Math.random`, no `Date.now`, no
 * I/O. Use `ctx.rng`, `ctx.tick`, `ctx.dt`.
 *
 * @example
 * const predictions = definePredictions(intents, {
 *   move: ({ dx, dy }, ctx) => {
 *     ctx.world.update(ctx.entity, Velocity, { vx: dx, vy: dy });
 *   },
 * });
 *
 * server.use(predictions);
 * client.use(predictions);
 */
export function definePredictions<I extends IntentSchemaMap>(
    intents: DefinedIntents<I>,
    map: PredictionMap<I>,
): DefinedPredictions<I> {
    return { __kind: 'predictions', intents, map };
}

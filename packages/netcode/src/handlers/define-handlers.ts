import type { DefinedIntents, IntentPayload, IntentSchemaMap } from '../intents/define-intents';
import type { ServerHandlerContext } from '../ctx';

/**
 * A single server-only handler. Runs only when an intent arrives from a
 * peer. May read/write server-only context (`peer`, `clientTick`,
 * `lagCompensated`) and is never replayed on the client.
 *
 * Use for intents whose effect is intrinsically server-authoritative:
 * hit detection with lag compensation, item purchases, anti-cheat
 * checks, chat broadcasts.
 */
export type HandlerFn<P> = (payload: P, ctx: ServerHandlerContext) => void;

/**
 * Bundle of server-only handlers keyed by intent name. Partial: most
 * games mix predictable intents (movement) with server-only handlers
 * (combat, economy).
 */
export type HandlerMap<I extends IntentSchemaMap> = {
    [K in keyof I]?: HandlerFn<IntentPayload<I, K>>;
};

/**
 * Tagged bundle returned by `defineHandlers`. Pass to
 * `server.use(handlers)`. Calling `client.use(handlers)` is a type error
 * because the bundle's `__kind` is server-specific.
 */
export interface DefinedHandlers<I extends IntentSchemaMap> {
    readonly __kind: 'handlers';
    readonly intents: DefinedIntents<I>;
    readonly map: HandlerMap<I>;
}

/**
 * Bundle server-only intent handlers. Register via
 * `server.use(handlers)`.
 *
 * @example
 * const handlers = defineHandlers(intents, {
 *   shoot: ({ from, dir }, ctx) => {
 *     ctx.lagCompensated(() => {
 *       const hit = raycast(ctx.world, from, dir);
 *       if (hit) ctx.world.update(hit.entity, Health, { hp: ... });
 *     });
 *   },
 * });
 *
 * server.use(handlers);
 */
export function defineHandlers<I extends IntentSchemaMap>(
    intents: DefinedIntents<I>,
    map: HandlerMap<I>,
): DefinedHandlers<I> {
    return { __kind: 'handlers', intents, map };
}

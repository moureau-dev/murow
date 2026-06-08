import { definePredictions } from 'murow/netcode';
import { intents } from './protocol';
import { Components } from './components';
import { ARENA_HALF, MOVE_SPEED } from './constants';
import { clamp } from '.';

/**
 * Movement prediction. Runs identically on the server (authoritative) and
 * the client (predicted) so the same WASD press produces the same world
 * state on both sides.
 *
 * The intent's `dx` / `dz` are normalized direction components. We multiply
 * by MOVE_SPEED and `ctx.deltaTime` to get the per-tick displacement.
 *
 * Deterministic: no Math.random, no Date.now, no module-level state.
 */
export const predictions = definePredictions(intents, {
    move: ({ dx, dz }, ctx) => {
        if (!ctx.world.has(ctx.entity, Components.Position)) return;

        const pos = ctx.fields(Components.Position);
        const x = pos.x[ctx.entity] + dx * MOVE_SPEED * ctx.deltaTime;
        const z = pos.z[ctx.entity] + dz * MOVE_SPEED * ctx.deltaTime;

        // Clamp to the arena bounds.
        pos.x[ctx.entity] = clamp(x, -ARENA_HALF * 2, ARENA_HALF * 2);
        pos.z[ctx.entity] = clamp(z, -ARENA_HALF * 2, ARENA_HALF * 2);
    },
});

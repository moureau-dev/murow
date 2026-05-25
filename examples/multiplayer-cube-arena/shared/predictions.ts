import { definePredictions } from 'murow/netcode';
import { intents } from './protocol';
import { Components } from './components';
import { ARENA_HALF, MOVE_SPEED } from './constants';

/**
 * Movement prediction. Runs identically on the server (authoritative) and
 * the client (predicted) so the same WASD press produces the same world
 * state on both sides.
 *
 * The intent's `dx` / `dz` are normalized direction components. We multiply
 * by MOVE_SPEED and `ctx.dt` to get the per-tick displacement.
 *
 * Deterministic: no Math.random, no Date.now, no module-level state.
 */
export const predictions = definePredictions(intents, {
    move: ({ dx, dz }, ctx) => {
        if (!ctx.world.has(ctx.entity, Components.Position)) return;
        const p = ctx.world.get(ctx.entity, Components.Position);
        const nx = p.x + dx * MOVE_SPEED * ctx.dt;
        const nz = p.z + dz * MOVE_SPEED * ctx.dt;

        // Clamp to the arena bounds. Same logic both sides → no
        // disagreement at the boundaries.
        const cx = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, nx));
        const cz = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, nz));
        ctx.world.update(ctx.entity, Components.Position, { x: cx, z: cz });
    },
});

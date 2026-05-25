import { f32 } from 'murow';
import { defineIntents, defineRpcs } from 'murow/netcode';

/**
 * Intents that flow client → server. `move` is the only one in this demo;
 * its prediction runs on both sides via the shared bundle below.
 *
 * `dx` and `dz` are normalized direction components in [-1, 1] (the client
 * computes them from WASD input each tick).
 */
export const intents = defineIntents({
    move: { dx: f32, dz: f32 },
});

/**
 * RPCs are bidirectional. We don't need any for this demo — spawn flows
 * through the regular snapshot pipeline because the server adds the
 * Position + Color components on connection. The empty schema is here so
 * the GameServer/GameClient constructors have an `rpcs` to pass.
 */
export const rpcs = defineRpcs({});

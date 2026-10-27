import { f32 } from 'murow';
import { defineProtocol } from 'murow/netcode';

/**
 * The shared protocol: intents, RPCs, and one versioned fingerprint.
 * `move` is the only intent in this demo; its prediction runs on both sides.
 *
 * `dx` and `dz` are normalized direction components in [-1, 1] (the client
 * computes them from WASD input each tick).
 */
export const protocol = defineProtocol({
    version: 1,
    intents: {
        move: { dx: f32, dz: f32 },
    },
    rpcs: {},
});

export const intents = protocol.intents;
export const rpcs = protocol.rpcs;

import { describe, test, expect } from 'bun:test';
import {
    FIXED_DT,
    MOVE_SPEED,
    Position,
    STEP_SEC,
    bootstrap,
    captureServerCounts,
    drain,
    makeHarness,
} from './index';

/**
 * Baseline scenario: latency + jitter, zero loss. Probes whether the
 * prediction/reconcile pipeline converges cleanly under bursty scheduling
 * when the transport is reliable (WebSocket-like).
 */
describe('convergence under jitter, no loss', () => {
    test('client and server agree on final position; all sent intents applied', () => {
        const jitter = { baseLatencyMs: 40, jitterMs: 20, lossChance: 0 };
        const h = makeHarness({ seed: 0xC0FFEE, numClients: 6, jitter });

        bootstrap(h, jitter);
        for (const sim of h.sims) expect(sim.localEntity).not.toBeNull();

        const FRAMES = 400;
        for (let frame = 0; frame < FRAMES; frame++) {
            const serverFirst = h.rng.chance(0.5);

            const runServer = () => {
                const batch = h.rng.int(0, 2);
                for (let k = 0; k < batch; k++) h.serverLoop.step(STEP_SEC);
            };
            const runClients = () => {
                const order = h.sims.slice();
                for (let i = order.length - 1; i > 0; i--) {
                    const j = h.rng.int(0, i);
                    [order[i], order[j]] = [order[j], order[i]];
                }
                for (const sim of order) {
                    const batch = h.rng.int(0, 2);
                    for (let k = 0; k < batch; k++) {
                        sim.loop.step(STEP_SEC);
                        if (h.rng.chance(0.85)) {
                            const ok = sim.client.sendIntent('move', { dx: sim.dx, dz: sim.dz });
                            if (ok) sim.sentIntents++;
                        }
                    }
                }
            };

            if (serverFirst) { runServer(); h.vnet.advance(h.rng.int(5, 25)); runClients(); }
            else { runClients(); h.vnet.advance(h.rng.int(5, 25)); runServer(); }
            h.vnet.advance(h.rng.int(10, 40));
        }

        drain(h, jitter);
        captureServerCounts(h);

        // No pending packets in the virtual network: anything still
        // queued would mean the test's post-conditions are reading
        // mid-flight state.
        expect(h.vnet.pending()).toBe(0);

        for (const sim of h.sims) {
            // Reliable transport: every intent applied.
            expect(sim.serverAppliedIntents).toBe(sim.sentIntents);

            // Server matches the closed-form sum of all applied intents.
            const expectedX = sim.serverAppliedIntents * sim.dx * MOVE_SPEED * FIXED_DT;
            const expectedZ = sim.serverAppliedIntents * sim.dz * MOVE_SPEED * FIXED_DT;
            const tol = Math.max(1e-4, sim.serverAppliedIntents * 5e-6);
            const server = h.serverWorld.get(sim.serverEntity, Position);
            expect(Math.abs(server.x - expectedX)).toBeLessThan(tol);
            expect(Math.abs(server.z - expectedZ)).toBeLessThan(tol);

            // After full drain, client converges to authoritative state.
            const local = sim.world.get(sim.localEntity!, Position);
            expect(local.x).toBeCloseTo(server.x, 5);
            expect(local.z).toBeCloseTo(server.z, 5);

            // Snapshot reordering: jitter can swap consecutive snapshots,
            // and the netcode currently does NOT filter them by tick. This
            // bounds the rate but doesn't claim zero - that would be a
            // separate fix.
            const staleRate = sim.staleSnapshots / Math.max(1, sim.snapshotsReceived);
            expect(staleRate).toBeLessThan(0.1);

            // Replay depth should never exceed the prediction buffer
            // (default 64). A higher value means the engine accepted a
            // replay window it cannot honor.
            expect(sim.maxReplayDepth).toBeLessThanOrEqual(64);
        }
    });
});

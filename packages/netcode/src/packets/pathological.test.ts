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
 * Stress test: the worst real-world scenario the netcode might face.
 * High latency, large jitter, meaningful loss, frequent reordering,
 * bursty scheduling, server starvation. The point isn't that the system
 * behaves smoothly - it's that it doesn't catastrophically break:
 *
 * - no NaN positions
 * - no negative or runaway tick replay
 * - convergence to server eventually happens for the LOST-INTENT-FREE
 *   portion (sent == applied) of each peer's stream
 * - correction magnitude stays bounded relative to per-tick motion
 * - prediction history never blows past the buffer cap
 */
describe('pathological network', () => {
    test('hostile latency + jitter + loss + reorder: bounded behavior, no NaNs', () => {
        const jitter = {
            baseLatencyMs: 250,
            jitterMs: 120,
            lossChance: 0.15,
            reorderChance: 0.4,
            reorderSkewMs: 150,
        };
        const h = makeHarness({
            seed: 0x5CAFFEE,
            numClients: 5,
            jitter,
            interpDelayMs: 250,
        });

        bootstrap(h, jitter, { warmupTicks: 10 });
        for (const sim of h.sims) expect(sim.localEntity).not.toBeNull();

        const FRAMES = 500;
        for (let frame = 0; frame < FRAMES; frame++) {
            const serverFirst = h.rng.chance(0.5);
            const runServer = () => {
                // Server occasionally starves: 30% chance the server
                // misses its tick entirely this frame.
                if (h.rng.chance(0.3)) return;
                const batch = h.rng.int(1, 3);
                for (let k = 0; k < batch; k++) h.serverLoop.step(STEP_SEC);
            };
            const runClients = () => {
                const order = h.sims.slice();
                for (let i = order.length - 1; i > 0; i--) {
                    const j = h.rng.int(0, i);
                    [order[i], order[j]] = [order[j], order[i]];
                }
                for (const sim of order) {
                    const batch = h.rng.int(0, 3);
                    for (let k = 0; k < batch; k++) {
                        sim.loop.step(STEP_SEC);
                        if (h.rng.chance(0.85)) {
                            const ok = sim.client.sendIntent('move', { dx: sim.dx, dz: sim.dz });
                            if (ok) sim.sentIntents++;
                        }
                    }
                }
            };

            if (serverFirst) { runServer(); h.vnet.advance(h.rng.int(20, 100)); runClients(); }
            else { runClients(); h.vnet.advance(h.rng.int(20, 100)); runServer(); }
            h.vnet.advance(h.rng.int(30, 150));
        }

        drain(h, jitter, 64);
        captureServerCounts(h);

        // Should NOT have hidden pending packets after drain.
        expect(h.vnet.pending()).toBe(0);

        const perTickMotion = MOVE_SPEED * FIXED_DT;

        for (const sim of h.sims) {
            const local = sim.world.get(sim.localEntity!, Position);
            const server = h.serverWorld.get(sim.serverEntity, Position);

            // Survival: no NaN, no Infinity anywhere.
            expect(Number.isFinite(local.x)).toBe(true);
            expect(Number.isFinite(local.z)).toBe(true);
            expect(Number.isFinite(server.x)).toBe(true);
            expect(Number.isFinite(server.z)).toBe(true);

            // Server state is exactly what it applied. This is the
            // strongest claim we can make under loss: the server's view
            // of the world is internally consistent.
            const expectedX = sim.serverAppliedIntents * sim.dx * MOVE_SPEED * FIXED_DT;
            const expectedZ = sim.serverAppliedIntents * sim.dz * MOVE_SPEED * FIXED_DT;
            const tol = Math.max(1e-3, sim.serverAppliedIntents * 5e-6);
            expect(Math.abs(server.x - expectedX)).toBeLessThan(tol);
            expect(Math.abs(server.z - expectedZ)).toBeLessThan(tol);

            // Local-vs-server divergence under loss is bounded by the
            // count of dropped intents (the unacked tail). This is the
            // honest claim until intent timeouts are implemented.
            const dropped = sim.sentIntents - sim.serverAppliedIntents;
            const maxDiff = (dropped + 4) * perTickMotion;
            const diff = Math.hypot(local.x - server.x, local.z - server.z);
            expect(diff).toBeLessThanOrEqual(maxDiff);

            // Replay depth bounded by the default prediction buffer (64).
            expect(sim.maxReplayDepth).toBeLessThanOrEqual(64);

            // Correction magnitude bounded by the in-flight budget.
            // High-jitter scenarios can stack ~20 unacked predictions;
            // anything above 40 ticks of motion would indicate a runaway
            // rollback or corrupted history.
            expect(sim.maxCorrection).toBeLessThan(perTickMotion * 40);

            // Some intents were lost: the test is meaningless if not.
            expect(dropped).toBeGreaterThan(0);
        }
    });
});

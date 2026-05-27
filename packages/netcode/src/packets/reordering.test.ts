import { describe, test, expect } from 'bun:test';
import {
    Position,
    STEP_SEC,
    bootstrap,
    captureServerCounts,
    drain,
    makeHarness,
} from './index';

/**
 * Probe: high jitter + explicit reorder can flip the relative arrival of
 * snapshots. The netcode currently does not filter stale snapshots by
 * tick, so this scenario exercises:
 *
 * - server intent ordering ratchet (lastAckedClientTick should ratchet up,
 *   never down, even if an older-tick intent arrives later)
 * - whether out-of-order snapshots produce visible jitter in the local
 *   predicted entity
 *
 * It does NOT claim zero stale snapshots: that's a known engine gap.
 * What it claims is that reordering does not corrupt convergence.
 */
describe('packet reordering', () => {
    test('out-of-order arrival does not break server-side convergence', () => {
        const jitter = {
            baseLatencyMs: 60,
            jitterMs: 50,
            lossChance: 0,
            reorderChance: 0.3,
            reorderSkewMs: 80,
        };
        const h = makeHarness({ seed: 0xBEEF, numClients: 4, jitter });

        bootstrap(h, jitter);
        for (const sim of h.sims) expect(sim.localEntity).not.toBeNull();

        const FRAMES = 300;
        for (let frame = 0; frame < FRAMES; frame++) {
            for (const sim of h.sims) {
                const batch = h.rng.int(0, 2);
                for (let k = 0; k < batch; k++) {
                    sim.loop.step(STEP_SEC);
                    if (h.rng.chance(0.85)) {
                        const ok = sim.client.sendIntent('move', { dx: sim.dx, dz: sim.dz });
                        if (ok) sim.sentIntents++;
                    }
                }
            }
            h.vnet.advance(h.rng.int(10, 40));
            const sb = h.rng.int(0, 2);
            for (let k = 0; k < sb; k++) h.serverLoop.step(STEP_SEC);
            h.vnet.advance(h.rng.int(10, 40));
        }

        drain(h, jitter);
        captureServerCounts(h);
        expect(h.vnet.pending()).toBe(0);

        let totalSnapshots = 0;
        let totalStale = 0;
        for (const sim of h.sims) {
            totalSnapshots += sim.snapshotsReceived;
            totalStale += sim.staleSnapshots;

            // Reliable transport (lossChance=0): server applied every intent.
            expect(sim.serverAppliedIntents).toBe(sim.sentIntents);

            // Client converges to authoritative state after drain.
            const local = sim.world.get(sim.localEntity!, Position);
            const server = h.serverWorld.get(sim.serverEntity, Position);
            expect(local.x).toBeCloseTo(server.x, 5);
            expect(local.z).toBeCloseTo(server.z, 5);
        }

        // Reordering DID happen at meaningful rate. Without this signal
        // the scenario is no different from the plain jitter test.
        const overallStaleRate = totalStale / Math.max(1, totalSnapshots);
        expect(overallStaleRate).toBeGreaterThan(0.05);
    });
});

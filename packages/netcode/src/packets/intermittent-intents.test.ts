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
 * Intermittent-sender reconciliation repro. One client sends continuously,
 * one client sends in bursts. When the intermittent sender resumes after
 * a quiet window, the local reconciliation correction must not exceed the
 * in-flight prediction budget.
 */
describe('intermittent senders do not cause large self-corrections', () => {
    test('one continuous + one intermittent client: bounded local corrections', () => {
        const jitter = {
            baseLatencyMs: 60,
            jitterMs: 30,
            lossChance: 0,
        };
        const h = makeHarness({
            seed: 0xC0FFEE,
            numClients: 2,
            jitter,
            direction: (i) => (i === 0 ? { dx: 1, dz: 0 } : { dx: 0, dz: 1 }),
            interpDelayMs: 120,
        });

        bootstrap(h, jitter);
        for (const sim of h.sims) expect(sim.localEntity).not.toBeNull();

        const FRAMES = 300;
        const BURST = 20;
        const IDLE = 20;
        for (let frame = 0; frame < FRAMES; frame++) {
            for (const sim of h.sims) {
                sim.loop.step(STEP_SEC);

                const phase = frame % (BURST + IDLE);
                const isContinuous = sim.id === 0;
                const isSending = isContinuous || phase < BURST;

                if (isSending) {
                    const ok = sim.client.sendIntent('move', { dx: sim.dx, dz: sim.dz });
                    if (ok) sim.sentIntents++;
                }
            }
            h.vnet.advance(h.rng.int(10, 30));
            h.serverLoop.step(STEP_SEC);
            h.vnet.advance(h.rng.int(10, 30));
        }

        drain(h, jitter);
        captureServerCounts(h);
        expect(h.vnet.pending()).toBe(0);

        const perTickMotion = MOVE_SPEED * FIXED_DT;

        for (const sim of h.sims) {
            const dropped = sim.sentIntents - sim.serverAppliedIntents;
            expect(dropped).toBeLessThan(sim.sentIntents * 0.2);

            const maxAcceptable = sim.maxReplayDepth * perTickMotion * 0.1;
            expect(sim.maxCorrection).toBeLessThan(maxAcceptable);

            const local = sim.world.get(sim.localEntity!, Position);
            const server = h.serverWorld.get(sim.serverEntity, Position);
            expect(local.x).toBeCloseTo(server.x, 4);
            expect(local.z).toBeCloseTo(server.z, 4);
        }
    });
});

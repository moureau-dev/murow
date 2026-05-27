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
 * Two-player rubberband repro. Both clients send continuously; each
 * observes the OTHER as a peer entity through the interpolation buffer.
 *
 * Hypothesis: snapshot reordering under jitter causes the interp buffer
 * to interleave non-monotonic entries, producing visible backward jumps
 * on peer entities even though the local prediction/reconcile pipeline
 * is correct.
 *
 * What we assert:
 * - both clients agree on the server's final state for both entities
 * - the peer entity's observed position over time is MONOTONIC along
 *   the peer's motion axis, modulo a small interp tolerance. Any
 *   significant backward step means the peer rubberbanded.
 */
describe('peer interpolation under jitter', () => {
    test('peer entity does not visibly move backward when both clients send', () => {
        const jitter = {
            baseLatencyMs: 80,
            jitterMs: 40,
            lossChance: 0,
        };
        // Two clients moving in fixed cardinal directions so monotonicity
        // along the chosen axis is trivial to verify.
        const h = makeHarness({
            seed: 0xFEEDFACE,
            numClients: 2,
            jitter,
            direction: (i) => (i === 0 ? { dx: 1, dz: 0 } : { dx: -1, dz: 0 }),
            interpDelayMs: 120,
        });

        bootstrap(h, jitter);
        for (const sim of h.sims) expect(sim.localEntity).not.toBeNull();

        // Each client tracks the OTHER client's entity position over time.
        // We sample at every client 'tick' event AFTER interp buffer apply
        // (which runs on 'sync' just before 'pre-tick').
        const observations: { observer: number; targetServerEid: number; samples: number[] }[] = [];
        for (const observer of h.sims) {
            for (const target of h.sims) {
                if (target === observer) continue;
                const entry = { observer: observer.id, targetServerEid: target.serverEntity, samples: [] as number[] };
                observations.push(entry);
                observer.loop.events.on('tick', () => {
                    const localEid = (observer.client as any).serverToLocal.get(target.serverEntity);
                    if (localEid === undefined) return;
                    if (!observer.world.has(localEid, Position)) return;
                    const p = observer.world.get(localEid, Position);
                    entry.samples.push(p.x);
                });
            }
        }

        const FRAMES = 250;
        for (let frame = 0; frame < FRAMES; frame++) {
            for (const sim of h.sims) {
                sim.loop.step(STEP_SEC);
                const ok = sim.client.sendIntent('move', { dx: sim.dx, dz: sim.dz });
                if (ok) sim.sentIntents++;
            }
            h.vnet.advance(h.rng.int(15, 35));
            h.serverLoop.step(STEP_SEC);
            h.vnet.advance(h.rng.int(15, 35));
        }

        drain(h, jitter);
        captureServerCounts(h);
        expect(h.vnet.pending()).toBe(0);

        // Server agrees with applied count.
        for (const sim of h.sims) {
            expect(sim.serverAppliedIntents).toBe(sim.sentIntents);
        }

        // For each observer/target pair, sampled positions must be
        // monotonic along the target's motion axis. A backward dip
        // beyond per-tick motion is a visible rubberband.
        const perTickMotion = MOVE_SPEED * FIXED_DT;
        // 0.6 of a per-tick step: the play-out clock can warp up to 10%
        // per sync while chasing the target, so the lerp `t` can briefly
        // produce a slightly larger step at boundary crossings. Anything
        // beyond this is a visible rubberband.
        const tolerance = perTickMotion * 0.6;

        for (const obs of observations) {
            const target = h.sims.find((s) => s.serverEntity === obs.targetServerEid)!;
            const sgn = Math.sign(target.dx);

            let maxBackstep = 0;
            for (let i = 1; i < obs.samples.length; i++) {
                const delta = (obs.samples[i] - obs.samples[i - 1]) * sgn;
                if (delta < -tolerance) {
                    const backstep = -delta;
                    if (backstep > maxBackstep) maxBackstep = backstep;
                }
            }

            if (maxBackstep > 0) {
                console.log(
                    `[peer interp] observer=${obs.observer} target=${obs.targetServerEid}`,
                    `samples=${obs.samples.length} maxBackstep=${maxBackstep.toFixed(4)}`,
                    `perTickMotion=${perTickMotion.toFixed(4)}`,
                );
            }

            expect(maxBackstep).toBeLessThan(tolerance);
        }
    });
});

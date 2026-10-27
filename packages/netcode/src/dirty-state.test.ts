import { describe, expect, test } from 'bun:test';
import { DirtyStateChecker } from './dirty-state';
import { Position, STEP_SEC, bootstrap, makeHarness } from './packets';

const jitter = { baseLatencyMs: 0, jitterMs: 0, lossChance: 0 };

describe('DirtyStateChecker', () => {
    test('server clears dirty after a snapshot tick', () => {
        const h = makeHarness({ seed: 1, numClients: 1, jitter });
        bootstrap(h, jitter);

        h.serverLoop.step(STEP_SEC);

        expect(new DirtyStateChecker(h.serverWorld, [Position]).count()).toBe(0);
    });

    test('prediction marks the networked component dirty', () => {
        const h = makeHarness({ seed: 2, numClients: 1, jitter });
        bootstrap(h, jitter);
        const sim = h.sims[0]!;
        expect(sim.localEntity).not.toBeNull();

        sim.world.clearAllDirty();
        const checker = new DirtyStateChecker(sim.world, [Position]);

        expect(sim.client.sendIntent('move', { dx: 1, dz: 0 })).toBe(true);
        expect(checker.count()).toBeGreaterThan(0);
        checker.assertDirty(sim.localEntity!, Position);

        sim.world.clearAllDirty();
        checker.assertClean();
    });

    test('assertClean reports dirty entries', () => {
        const h = makeHarness({ seed: 3, numClients: 1, jitter });
        bootstrap(h, jitter);
        const sim = h.sims[0]!;
        sim.world.markDirty(sim.localEntity!, Position.__worldIndex!);

        const checker = new DirtyStateChecker(sim.world, [Position]);
        expect(() => checker.assertClean()).toThrow('dirty');

        sim.world.clearAllDirty();
    });
});

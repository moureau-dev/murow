# packets

End-to-end tests for `murow/netcode`, driven through `GameServer` + `GameClient`. Every scenario runs over a seedable `VirtualServerTransport` (`murow/net`), so latency, jitter, loss, and reordering are deterministic and reproducible.

## Harness (`harness.ts`)

Shared scenario builder. Exports `MOVE_SPEED`, `TICK_RATE`, `STEP_SEC`, `FIXED_DT`, the `Position` component, and:

- `makeHarness({ seed, numClients, jitter, direction?, interpDelayMs? })` builds a server world/loop, one client world/loop per client, assigns an entity per client, and returns `{ rng, vnet, transport, serverLoop, serverWorld, server, sims, serverIntentsByPeer }`.
- `bootstrap(h, steadyState, { warmupTicks? })` runs one lossless round so every client receives its assignment, then switches to the steady-state jitter config.
- `drain(h, jitter, ticks?)` re-enables a lossless config and advances the network so post-conditions read settled state.
- `captureServerCounts(h)` copies per-peer applied-intent counts into each sim.
- `hashPositions(world, entities)` FNV-1a hash over `Position` fields, for determinism probes.
- `PeerSim` per-client bookkeeping: `sentIntents`, `serverAppliedIntents`, `reconciles`, `maxCorrection`, `maxReplayDepth`, `snapshotsReceived`, `staleSnapshots`, `lastSnapshotTick`.

## Tests

| File | Asserts |
|---|---|
| `convergence.test.ts` | Latency + jitter, no loss: every sent intent is applied and each client converges to the server's position after drain. |
| `reordering.test.ts` | Explicit reordering: server-side intent ordering stays monotonic and convergence holds; reordering occurs at a measurable rate. |
| `peer-interpolation.test.ts` | Under jitter, a peer entity's sampled position is monotonic along its motion axis (no backward jump / rubberband). |
| `pathological.test.ts` | High latency + jitter + loss + reorder + server starvation: no NaN/Infinity, server state equals applied intents, divergence bounded by dropped intents, replay depth within the buffer cap. |
| `intermittent-intents.test.ts` | A bursty sender does not produce large local reconciliation corrections. |
| `features.test.ts` | Feature behavior: slerp quaternion interpolation with lerp fallback, per-component interest, `snapThreshold`, AOI enter/leave and global pass-through, wire quantization, per-peer byte budget + priority, independent per-component interest resolution, and schema-fingerprint mismatch. |

## Notes

- `staleSnapshots` counts arrivals whose tick is not strictly greater than the previously received tick. It measures arrival order, not state corruption: the interpolation buffer orders samples by tick (`murow/core/timeline`), and reconciliation ignores a snapshot whose tick is `<=` the last reconciled tick.
- Loss is exercised but not recovered. There is no intent retransmit or timeout; the server skips a sequence gap after `STALL_LIMIT`. Convergence resolves to the server's state, and a lost intent's effect is dropped.

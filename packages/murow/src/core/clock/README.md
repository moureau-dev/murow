# SlewClock

A scalar that advances one nominal step per call toward a moving target, slewing within a band to close drift, holding steady inside a dead-zone, and snapping when the forward gap is too large to chase.

It is a domain-agnostic control primitive (a slew-rate-limited follower / software clock-recovery). The caller decides what the target is and what counts as too-far-to-chase; the clock only knows how to follow.

## Features

- Advances at a nominal rate of 1 per call, correcting drift by warping within a configurable band.
- Dead-zone: when already in sync, advances at the nominal rate instead of micro-correcting, so it holds steady.
- Forward snap: if the target jumps too far ahead to reach by warping, jumps straight to it.
- Seeds to the first target automatically; `reset()` re-seeds on the next call.
- Zero dependencies, domain-agnostic.

## Usage

```typescript
import { SlewClock } from './clock';

const clock = new SlewClock({ deadZone: 0.25, warp: { min: 0.6, max: 1.4 }, gain: 0.1 });

// Each step, follow the latest target estimate. `snap` is the forward drift
// beyond which the clock gives up warping and jumps.
const value = clock.advance(targetEstimate, snapThreshold);
```

## Options

- `deadZone` (default 0.25): drift under this advances at the nominal rate, no warp.
- `warp.min` / `warp.max` (default 0.6 / 1.4): bounds on the step while warping to close drift.
- `gain` (default 0.1): how strongly drift bends the step toward closing the gap.

## API

- `advance(target, snap)`: advance one step toward `target`; returns the new value. Seeds to `target` on the first call.
- `value`: the current value.
- `initialized`: whether the clock has been seeded.
- `reset()`: drop the seed so the next `advance` re-seeds.

## Notes

The snap threshold is supplied per call so it can scale with the caller's units (for example, a tick rate that varies at runtime). Snap is forward-only on purpose: jumping backward would read as a visible rubberband.

This is the mechanism only. Pointing it at a target (and tuning the band/snap) is the consumer's job. The netcode play-out clock, for instance, follows `newest - delay`.

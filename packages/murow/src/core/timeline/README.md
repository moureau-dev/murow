# Timeline

A bounded, tick-ordered ring of timestamped samples. Inserts in tick order (deduping by tick), prunes to capacity, drops history when a wall-clock gap exceeds a stale window, and finds the two samples that straddle a given tick.

It knows nothing about what a sample contains; `S` is opaque. Useful anywhere you keep a short history of timestamped state and read it back by time: snapshot interpolation, replays, kill-cams, ghosts, rewind mechanics.

## Features

- Tick-ordered insert with dedup, so out-of-order arrivals land in the right place.
- Capacity-bounded: the oldest entry is dropped once the ring is full.
- Stale reset: a wall-clock gap beyond the stale window drops the old history and reports it.
- `straddle(tick)`: the bracketing pair around a point in time, for interpolation.
- Generic over the sample type; zero dependencies.

## Usage

```typescript
import { Timeline } from './timeline';

const tl = new Timeline<MySample>(16, 1000); // capacity, staleWindow ms

// `record` returns true if a stale gap forced the history to be dropped first.
const wasReset = tl.record(tick, receivedAt, sample);

// Find the pair straddling a render time, then interpolate between them.
const pair = tl.straddle(renderTick);
if (pair) {
    const [a, b] = pair;
    const from = tl.at(a).sample;
    const to = tl.at(b).sample;
    // interpolate from -> to ...
}
```

## API

- `record(tick, receivedAt, sample)`: insert in tick order; returns true if a stale-window gap reset the history first.
- `straddle(tick)`: `[a, b]` indices of the consecutive entries bracketing `tick`, or `null`.
- `newest()` / `oldest()`: the end entries, or `undefined` when empty.
- `at(index)`: the entry at an index (`{ tick, receivedAt, sample }`).
- `length`, `latestReceivedAt`.
- `setStaleWindow(ms)`, `clear()`.

## Notes

The stale window is in wall-clock milliseconds (`receivedAt`), while ordering and straddle work on the logical `tick`. Keeping both lets a consumer detect a delivery stall (wall gap) independently of the tick timeline it is replaying.

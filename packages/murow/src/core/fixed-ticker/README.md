# FixedTicker

`FixedTicker` is a utility class for managing fixed-rate update ticks in JavaScript/TypeScript applications. It is designed for deterministic game loops, working both in the browser (e.g., with Pixi.js) and on Node.js servers.

This class ensures that updates run at a fixed timestep, which is essential for predictable, lockstep multiplayer simulations.

---

## Features

- Fixed-timestep updates with configurable tick rate.
- Accumulates elapsed time and determines how many ticks to process per frame.
- Limits the maximum number of ticks per frame to prevent runaway loops.
- Provides a tick count for deterministic simulation.
- Optional callback for detecting skipped ticks (useful for debugging or network reconciliation).
- Compatible with both client and server environments.

## Usage

```typescript
import { FixedTicker } from './fixed-ticker';

const ticker = new FixedTicker({
  rate: 30, // ticks per second
  onTick: (deltaTime, tick) => {
    // Your fixed-step game logic here
    // deltaTime = 1 / rate
    console.log(`Tick ${tick} - dt: ${deltaTime}`);
  },
  onTickSkipped: (skipped) => {
    console.warn(`Skipped ${skipped} ticks due to high delta time`);
  }
});

// Call once per frame, passing elapsed time in seconds
function gameLoop(deltaTime: number) {
  ticker.tick(deltaTime);

  // Optional: interpolate visuals using alpha (0-1)
  render(ticker.alpha); // for smooth rendering between ticks
}
```

## Notes

- This class does not automatically guarantee determinism; your game logic must also be deterministic (e.g., using seeded random numbers and consistent math operations).
- For lockstep multiplayer, always use the tickCount to synchronize inputs and simulation steps.
- Use `ticker.alpha` for smooth client-side rendering between fixed ticks (automatically clamped to prevent extrapolation).

## Example: Deterministic Multiplayer Loop

```typescript
const ticker = new FixedTicker({
  rate: 12, // will fire the onTick callback 12 times per second
  onTick: (deltaTime, tick) => {
    applyInputsForTick(tick);
    updateSimulation(deltaTime);
  }
});

// in browser
function frame(deltaTime: number) {
  ticker.tick(deltaTime);
  render(interpolate(ticker.alpha));
}

// in Node.js
setInterval(() => {
  const deltaTime = 1 / ticker.rate; // fixed timestep
  ticker.tick(deltaTime);
  updateSimulation(deltaTime);
}, 1000 / ticker.rate);
```

---

`FixedTicker` provides a reliable, minimal, and deterministic foundation for game loops and simulations where consistent, fixed-step updates are crucial.

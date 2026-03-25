# Driver

Environment-aware game loop drivers for client (browser) and server (Node.js).
Provides variable delta time that should be consumed by `FixedTicker` for deterministic game logic.

---

## Features

- **Environment-Specific**: Uses `requestAnimationFrame` (client) or `setImmediate` (server)
- **Automatic Delta Time**: Calculates delta in seconds between frames
- **Simple API**: Start and stop with a single method call
- **Designed for FixedTicker**: Provides variable dt that FixedTicker converts to fixed timesteps

---

## Usage

### Recommended: With FixedTicker

```typescript
import { createDriver } from '@/core/loop';
import { FixedTicker } from '@/core/fixed-ticker';

const ticker = new FixedTicker({
  rate: 30,
  onTick: (fixedDt, tick) => {
    world.update(fixedDt);
    applyInputs(tick);
  }
});

// Client: RAF driver with interpolation
const clientDriver = createDriver('client', (dt) => {
  ticker.tick(dt);
  render(ticker.alpha); // Smooth 60 FPS rendering of 30 TPS simulation
});
clientDriver.start();

// Server: Immediate driver for high-frequency updates
const serverDriver = createDriver('server', (dt) => {
  ticker.tick(dt);
  broadcastState();
});
serverDriver.start();
```

### Direct Usage (Single-player only)

```typescript
import { createDriver } from '@/core/loop';

// ⚠️ Variable delta time - not suitable for multiplayer
const driver = createDriver('client', (dt) => {
  player.update(dt);
  renderer.render();
});
driver.start();
```

---

## Drivers

### `RafDriver` (Client)
- Uses `requestAnimationFrame`
- Syncs with display refresh rate (~60 FPS)
- Automatic throttling when tab not visible

### `ImmediateDriver` (Server)
- Uses `setImmediate` (Node.js only)
- Runs as fast as possible without blocking event loop
- Suitable for server simulations

---

## API

```typescript
createDriver(type: 'client' | 'server', update: (dt: number) => void): LoopDriver
```

```typescript
interface LoopDriver {
  start(): void;  // Start the loop
  stop(): void;   // Stop the loop
}
```

---

## Notes

- Delta time (`dt`) is always in **seconds**, not milliseconds
- **Always use with FixedTicker** for multiplayer/deterministic games
- Direct usage without FixedTicker only suitable for single-player scenarios
- `ImmediateDriver` requires Node.js (uses `setImmediate`)

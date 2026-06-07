# Game Loop

The Game Loop module provides a flexible and efficient way to manage the main loop of a game, handling [fixed-rate ticker](../../core/fixed-ticker), variable-rate rendering and [client inputs](../../core/input). It supports different [driver types](../../core/driver/drivers) for client and server environments.

## Usage

Hook it to a game simulation, [ECS](../../ecs), or any other game logic by listening to tick events or providing callback functions.

```typescript
import { GameLoop } from "murow";

const loop = new GameLoop({
    type: 'client',
    // or 'server-immediate' / 'server-timeout'
    // or 'manual-client' / 'manual-server'
    tickRate: 12, // ticks per second
});

// Events way: Listen to various loop events, such as tick.
// tick event runs at fixed intervals defined by tickRate
loop.events.on('tick', ({ deltaTime, tick }) => {
    console.log(`Tick ${tick} with deltaTime ${deltaTime}`);
});
// render event in the client, runs at every frame at your monitor refresh rate
loop.events.on('render', ({ deltaTime, alpha }) => {
    console.log(`Render frame with deltaTime ${deltaTime} and alpha ${alpha}`);
});

loop.start();

// Play with the loop (all emits events as well)
loop.stop();
loop.pause();
loop.resume();
```

## Schedules

Run a callback on a fixed interval with `every`. Units are sugar: `seconds` and
`milliseconds` are converted to a tick count from the loop's `tickRate`, so a
schedule fires in lockstep with the simulation no matter which unit you pick.

```typescript
const waveId = loop.every(2).seconds(spawnWave);
loop.every(4).ticks(stepAi);
loop.every(500).milliseconds(pollServer);

// Cancel one schedule, or all of them.
loop.clearSchedule(waveId);
loop.clearSchedules();
```

- `every(...)` returns a numeric id for `clearSchedule`, or `-1` if the pool is full.
- They fire after `post-tick` and realign from the current tick, so a long frame fires once, not a burst.
- They survive `stop()` and re-anchor on the next `start()` — no need to re-register.

The pool is fixed-capacity and zero-GC (default 32 concurrent schedules). Raise it with `maxSchedules`:

```typescript
const loop = new GameLoop({ type: 'server-immediate', tickRate: 30, maxSchedules: 64 });
```

## Manual Mode

`manual-client` and `manual-server` do not start an internal [driver](../../core/driver).

You must manually advance the loop(s) through the `.step(deltaTime)` method.

In other modes, `.step(deltaTime)` is automatically called internally by the [driver](../../core/driver).

This is ideal for multiple instances ticking at once or if you want to own the
clock yourself:

```ts
const loopA = new GameLoop({
  type: 'manual-server',
  tickRate: 30,
});

const loopB = new GameLoop({
  type: 'manual-server',
  tickRate: 20,
});

const loopC = new GameLoop({
  type: 'manual-server',
  tickRate: 15,
});

const loops = [loopA, loopB, loopC];

for (const loop of loops) {
    loop.step(deltaTime);
}
```

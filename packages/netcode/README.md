# murow/netcode

Snapshot sync, prediction with rollback, jitter interpolation, and
interest management over `murow`'s ECS and transport primitives.

Shipped under the `murow` package as a subpath. No separate install.

```ts
import { GameServer, GameClient } from 'murow/netcode';
```

## At a glance

| Feature | What it does |
|---|---|
| `GameServer` / `GameClient` | Typed network endpoints. Hook into a `GameLoop`, take a `World` and a protocol bundle. |
| `defineIntents` / `defineRpcs` | Schema sugar over `defineIntent` / `defineRPC`. Numeric kinds auto-assigned, codecs built, TypeScript inference flows into `sendIntent` / `sendRpc`. |
| `definePredictions` | Deterministic logic that runs identically on both sides. Server is authoritative, client predicts + rolls back. |
| `defineHandlers` | Server-only logic with `peer`, `clientTick`, `lagCompensated()`. Never runs on the client. |
| `networked()` | Type-checked `sync` block for `defineComponent`. Controls rate, interest, interp, snapThreshold. |
| `InterpolationBuffer` (internal) | Renders behind newest snapshot to absorb jitter. Tunable via `interpolation.delay`. |
| `assignEntity` / `'assigned'` | Server tells the client which entity is theirs. Client auto-marks it predicted. |
| `AoiGrid` | Spatial interest plugin. Filters per-peer snapshots by radius. |
| `LagCompensation` | Server-side state rewind for fair hit detection across pings. |
| `MemoryServerTransport` | In-process transport pair for tests. |

## Minimal example

A complete top-down skeleton in about 60 lines.

<details>
<summary><b>shared/protocol.ts</b> (components, intents, RPCs)</summary>

```ts
import { defineComponent, f32, u16 } from 'murow';
import { defineIntents, defineRpcs, networked } from 'murow/netcode';

export const Position = defineComponent('Position', {
  schema: { x: f32, y: f32 },
  sync: networked({ rate: 'every-tick', interest: 'aoi', interp: 'lerp' }),
});

export const Health = defineComponent('Health', {
  schema: { hp: u16 },
  sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
});

export const intents = defineIntents({
  move:  { dx: f32, dy: f32 },
  shoot: { fromX: f32, fromY: f32, dirX: f32, dirY: f32 },
});

export const rpcs = defineRpcs({
  matchStart: { countdownSec: u16 },
});
```
</details>

<details>
<summary><b>shared/predictions.ts</b> (shared deterministic logic)</summary>

```ts
import { definePredictions } from 'murow/netcode';
import { intents, Position } from './protocol';

export const predictions = definePredictions(intents, {
  move: ({ dx, dy }, ctx) => {
    const p = ctx.world.get(ctx.entity, Position);
    ctx.world.update(ctx.entity, Position, {
      x: p.x + dx * ctx.deltaTime,
      y: p.y + dy * ctx.deltaTime,
    });
  },
});
```
</details>

<details>
<summary><b>server.ts</b> (authoritative side)</summary>

```ts
import { GameLoop, World } from 'murow';
import { GameServer, defineHandlers, AoiGrid, LagCompensation } from 'murow/netcode';
import { intents, rpcs, Position, Health } from './shared/protocol';
import { predictions } from './shared/predictions';

const world = new World({ maxEntities: 1000, components: [Position, Health] });
const loop = new GameLoop({ tickRate: 20, type: 'server-timeout' });
const server = new GameServer({
  world, loop, transport: yourTransport,
  protocol: { intents, rpcs },
  snapshot: { rate: 20 },
});

const handlers = defineHandlers(intents, {
  shoot: ({ fromX, fromY, dirX, dirY }, ctx) => {
    ctx.lagCompensated(() => {
      // Hit detection here runs against the world as the shooter saw it.
    });
  },
});

server.use(predictions);
server.use(handlers);
server.use(new AoiGrid({ cellSize: 32, radius: 50, positionComponent: Position }));
server.use(new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] }));

server.on('connection', ({ peer }) => {
  const e = world.spawn();
  world.add(e, Position, { x: 0, y: 0 });
  world.add(e, Health, { hp: 100 });
  server.assignEntity(peer, e);
});

loop.start();
```
</details>

<details>
<summary><b>client.ts</b> (predicted side with interpolated peers)</summary>

```ts
import { GameLoop, World } from 'murow';
import { GameClient } from 'murow/netcode';
import { intents, rpcs, Position, Health } from './shared/protocol';
import { predictions } from './shared/predictions';

const world = new World({ maxEntities: 1000, components: [Position, Health] });
const loop = new GameLoop({ tickRate: 20, type: 'client' });
const client = new GameClient({
  world, loop, transport: yourTransport,
  protocol: { intents, rpcs },
  strategy: { kind: 'snapshot-interpolation', delay: 100 },
});
client.use(predictions);

let me: number | null = null;
client.on('assigned', ({ entity }) => { me = entity; });

loop.events.on('tick', ({ input }) => {
  const dx = (input.keys['KeyD']?.down ? 1 : 0) - (input.keys['KeyA']?.down ? 1 : 0);
  const dy = (input.keys['KeyS']?.down ? 1 : 0) - (input.keys['KeyW']?.down ? 1 : 0);
  if (me !== null && (dx !== 0 || dy !== 0)) client.sendIntent('move', { dx, dy });
});

loop.start();
```
</details>

## How it ticks

The server does its snapshot work in `post-tick`. The client pulls
interpolated network state into the world in `sync` (before the user's
tick handler reads it), then renders at framerate.

```
Server tick:                          Client tick:
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ sync       no-op                │   │ sync       interpolated state   │
│ pre-tick   user                 │   │ pre-tick   user (PREV capture)  │
│ tick       user (systems, etc.) │   │ tick       user (sendIntent...) │
│ post-tick  snapshot + despawn   │   │ post-tick  no-op                │
└─────────────────────────────────┘   │ render     user, at framerate   │
                                      └─────────────────────────────────┘
```

<details>
<summary><b>Snapshot wire format</b></summary>

```
[type=0x80]
[tick: u32][clientAckTick: u32][entityCount: u16][despawnCount: u16]
for each entity:
  [serverEid: u32][bitmask: u32 * N][packed component fields]
for each despawn:
  [serverEid: u32]
```

`clientAckTick` is the highest client-stamped tick the server has
applied for the receiving peer. The reconciler uses this (not the
server tick) to drop confirmed predictions.
</details>

<details>
<summary><b>Entity assignment frame</b></summary>

```
[type=0x84][serverEid: u32]
```

Sent on every `server.assignEntity(peer, e)` call. The client buffers
the assignment if the entity isn't yet known locally, then resolves it
on the matching spawn.
</details>

## Concepts

### Intents

One-shot client-to-server messages: player actions. Numeric kinds are
auto-assigned starting at 1 (0 is reserved for engine control frames).

```ts
client.sendIntent('move', { dx: 1, dy: 0 });
```

`ctx.entity` is the server-assigned entity. Target ids
(`attack({ targetId })`, `openChest({ chestId })`) belong in the
payload itself.

### RPCs

Named bidirectional messages outside the state-sync pipeline. Use for
match start, achievements, UI events.

```ts
server.broadcastRpc('matchStart', { countdownSec: 3 });
client.on('rpc', ({ name, args }) => { /* ... */ });
```

### Predictions

Deterministic logic that runs on both sides. The server applies it
authoritatively; the client applies it locally and keeps the result in
a buffer for rollback when the snapshot disagrees.

```ts
server.use(predictions);
client.use(predictions);
```

### Handlers

Server-only logic. Has access to `peer`, `clientTick`, and
`lagCompensated()`. Never runs on the client.

```ts
server.use(handlers);
// Don't `client.use(handlers)` -- it's a type error by design.
```

### Networked components

Components with a `sync` block participate in the snapshot pipeline.
Without `sync`, they're local-only.

```ts
const Position = defineComponent('Position', {
  schema: { x: f32, y: f32 },
  sync: networked({ rate: 'every-tick', interest: 'aoi', interp: 'lerp' }),
});
```

`networked(...)` is identity sugar with full type checking on `rate`,
`interest`, `interp`, and `snapThreshold`.

### Entity assignment

```ts
server.assignEntity(peer, entityId);
```

Pushes a `MSG_ASSIGN_ENTITY` frame. On the client:

```ts
client.on('assigned', ({ entity }) => { /* this peer's entity */ });
client.sendIntent('move', { dx, dy }); // ctx.entity = assigned entity
```

If the assignment lands before the entity exists locally (snapshot
ordering), the client buffers it and resolves on the matching spawn.

## Configuration

<details>
<summary><b>Server</b></summary>

```ts
new GameServer({
  world, loop, transport,
  protocol: { intents, rpcs },
  snapshot: { rate: 20 },     // clamped to tickRate
  kick: { ackTimeout: 2000 }, // ms before forcing close
});
```

Defaults: `snapshot.rate = min(20, tickRate)`, `kick.ackTimeout = 2000`.
</details>

<details>
<summary><b>Client</b></summary>

```ts
new GameClient({
  world, loop, transport,
  protocol: { intents, rpcs },
  strategy: { kind: 'snapshot-interpolation', delay: 100, staleWindow: 300 },
  prediction: { bufferSize: 64 },
});
```

Defaults: `strategy = { kind: 'snapshot-interpolation', delay: 100 }`,
`staleWindow = delay * 2 + 100`, `prediction.bufferSize = 64`.

- `strategy.kind`: peer-rendering strategy. Only
  `'snapshot-interpolation'` ships today; extrapolation and rollback
  will slot in here.
- `delay`: ms behind newest snapshot the buffer renders (snapshot-interp
  strategy only).
- `staleWindow`: max ms gap between snapshots before history is dropped
  as stale. Tuned for the normal cadence + jitter slop.
- `bufferSize`: max buffered unacked predictions kept for rollback.
</details>

<details>
<summary><b>Per-component (via <code>networked()</code>)</b></summary>

```ts
networked({
  rate: 'every-tick' | 'on-change' | { every: N },
  interest: 'global' | <plugin-name-string>,
  interp: 'lerp' | 'slerp' | 'step' | 'none',
  snapThreshold: number,
});
```

- `rate`: snapshot eligibility cadence.
- `interest`: visibility filter; matches a plugin's `name`, or
  `'global'` for "every peer sees this".
- `interp`: per-field interpolation mode.
- `snapThreshold`: per-component override of the reconciliation
  snap-vs-smooth threshold.
</details>

## Plugins

Register with `server.use(plugin)`. Hooks: `onMount`, `onTick`,
`onIntent`, `filterSnapshot`, `onDisconnect`.

### `AoiGrid`

Filters per-peer snapshots to entities within
`radius + hysteresisRadius` of the peer's assigned entity.

```ts
server.use(new AoiGrid({
  name: 'aoi',
  cellSize: 32,        // reserved for grid acceleration
  radius: 50,
  hysteresisRadius: 4,
  positionComponent: Position,
}));
```

The plugin's `name` matches the `interest` string on components.

### `LagCompensation`

Ring buffer of component snapshots over `historyMs`. Inside a server
handler, `ctx.lagCompensated(fn)` runs `fn` with the world rewound to
the tick the client believed it was on.

```ts
server.use(new LagCompensation({
  tickRate: 20,
  historyMs: 500,
  components: [Position],
}));
```

<details>
<summary><b>Writing your own plugin</b></summary>

```ts
import type { ServerPlugin } from 'murow/netcode';

class TelemetryPlugin implements ServerPlugin {
  readonly name = 'telemetry';

  onIntent(peer, kind, name, payload, ctx) {
    // Every intent the server dispatches goes through here.
  }

  filterSnapshot(peer, world, dirty, out) {
    // Push entities visible to `peer` onto `out`. Plugins compose in
    // registration order.
    for (const eid of dirty) out.push(eid);
  }
}

server.use(new TelemetryPlugin());
```
</details>

## Events

`GameServer extends EventSystem<ServerEventPayloads>`;
`GameClient extends EventSystem<ClientEventPayloads>`. The public types
narrow `emit` out, so only the engine fires engine events.

<details>
<summary><b>Server events</b></summary>

```ts
server.on('connection',     ({ peer }) => { ... });
server.on('disconnection',  ({ peer, reason }) => { ... });
server.on('intent',         ({ peer, name, payload, tick }) => { ... });
server.on('intent-failed',  ({ peer, kind, reason }) => { ... });
server.on('rpc',            ({ peer, name, args }) => { ... });
server.on('snapshot',       ({ peer, tick, byteSize }) => { ... });
server.on('error',          ({ error, context }) => { ... });
```
</details>

<details>
<summary><b>Client events</b></summary>

```ts
client.on('connected',    () => { ... });
client.on('disconnected', ({ reason }) => { ... });
client.on('kicked',       ({ reason }) => { ... });
client.on('snapshot',     ({ tick, byteSize }) => { ... });
client.on('rpc',          ({ name, args }) => { ... });
client.on('spawn',        ({ entity, components }) => { ... });
client.on('despawn',      ({ entity }) => { ... });
client.on('reconciled',   ({ rewindTick, replayed }) => { ... });
client.on('assigned',     ({ entity }) => { ... });
client.on('error',        ({ error, context }) => { ... });
```
</details>

### `on('intent')` vs `defineHandlers`

`on('intent')` is observe-only telemetry. `defineHandlers` is the
single registration point for gameplay. They coexist:

```ts
server.on('intent', (e) => log(e));
server.use(defineHandlers(intents, { /* ... */ }));
```

## Determinism rules for predictions

Predictions replay during rollback. Same input must produce same output.

1. No `Math.random()`. Use `ctx.rng`.
2. No `Date.now()` / `performance.now()`. Use `ctx.tick` or `ctx.deltaTime`.
3. No network, audio, file I/O, or DOM.
4. No reads from module-level mutable state. Keep state in components.
5. Predictions should only write to networked components. Touching
   local-only state from a prediction means rollback can corrupt UI.

Server-only handlers can do anything.

## Tick rates

`GameServer` and `GameClient` read the tick rate from `loop.ticker.rate`.
Snapshot scheduling, `ctx.deltaTime`, and lag-compensation history
sizing all adapt to it.

Server and client should share the same tick rate when predictions are
in use. Predictions assume both sides advance at the same `deltaTime`.

## Transport

Implement `TransportAdapter` from `murow`. Bundled:

- `MemoryServerTransport`: in-process pair for tests.

Murow's WebSocket transports (`BunWebSocketServerTransport`, browser
`BrowserWebSocketClientTransport`) work directly with `GameServer` and
`GameClient`.

<details>
<summary><b>Writing your own transport</b></summary>

```ts
import type { TransportAdapter, ServerTransportAdapter } from 'murow/netcode';

class MyServerTransport implements ServerTransportAdapter<MyPeerTransport> {
  // onConnection, onDisconnection, getPeer, getPeerIds, close
}

class MyPeerTransport implements TransportAdapter {
  // send, onMessage, onOpen, onClose, onError, close
}
```

The multiplayer layer assumes ordered delivery. WebSocket over TCP
satisfies that; UDP would need its own ordering/reliability layer.
</details>

## File layout

```
src/
├── intents/define-intents.ts
├── rpcs/define-rpcs.ts
├── predictions/define-predictions.ts
├── handlers/define-handlers.ts
├── components/sync-spec.ts
├── network/base.ts
├── server/
│   ├── game-server.ts
│   └── plugins/
│       ├── plugin.ts
│       ├── aoi-grid.ts
│       └── lag-compensation.ts
├── client/
│   ├── game-client.ts
│   └── interpolation-buffer.ts
├── codec/delta-codec.ts
├── transports/memory-transport.ts
└── ctx.ts
```

## License

MIT.

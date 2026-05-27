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
| `ctx.fields(C)` | Inside predictions/handlers, returns the typed-array bundle for the active entity and auto-marks it dirty for synced components. RAW-speed reads/writes, zero allocation. |
| `ctx.markDirty(C \| Cs, entity?)` | Explicit dirty-mark for cross-entity writes or no-op-path skipping when reaching into `ctx.world.fields()` directly. Accepts a single component or an array. |
| `InterpolationBuffer` (internal) | Renders behind newest snapshot to absorb jitter. Tunable via `interpolation.delay`. |
| `assignEntity` / `'assigned'` | Server tells the client which entity is theirs. Client auto-marks it predicted. |
| `AoiGrid` | Spatial interest plugin. Filters per-peer snapshots by radius. |
| `LagCompensation` | Server-side state rewind for fair hit detection across pings. |
| `MemoryServerTransport` | In-process transport pair for tests. |

## Minimal example

Top-down movement. One networked component, one intent, one prediction
shared between server and client.

<details>
<summary><b>shared/protocol.ts</b></summary>

```ts
import { defineComponent, f32 } from 'murow';
import { defineIntents, defineRpcs, networked } from 'murow/netcode';

export const Position = defineComponent('Position', {
  schema: { x: f32, y: f32 },
  sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

export const intents = defineIntents({
  move: { dx: f32, dy: f32 },
});

export const rpcs = defineRpcs({});
```
</details>

<details>
<summary><b>shared/predictions.ts</b></summary>

```ts
import { definePredictions } from 'murow/netcode';
import { intents, Position } from './protocol';

export const predictions = definePredictions(intents, {
  move: ({ dx, dy }, ctx) => {
    const pos = ctx.fields(Position);
    pos.x[ctx.entity] += dx * ctx.deltaTime;
    pos.y[ctx.entity] += dy * ctx.deltaTime;
  },
});
```
</details>

<details>
<summary><b>server.ts</b> (run with Bun)</summary>

```ts
import { BunWebSocketServerTransport, GameLoop, World } from 'murow';
import { GameServer } from 'murow/netcode';
import { intents, rpcs, Position } from './shared/protocol';
import { predictions } from './shared/predictions';

const transport = BunWebSocketServerTransport.create(3000, { path: '/ws' });

const world = new World({ maxEntities: 64, components: [Position] });
const loop = new GameLoop({ tickRate: 20, type: 'server-timeout' });
const server = new GameServer({
  world, loop, transport,
  protocol: { intents, rpcs },
});

server.use(predictions);

server.on('connection', ({ peer }) => {
  const e = world.spawn();
  world.add(e, Position, { x: 0, y: 0 });
  server.assignEntity(peer, e);
});

loop.start();
```
</details>

<details>
<summary><b>client.ts</b> (runs in the browser)</summary>

```ts
import { GameLoop, World } from 'murow';
import { BrowserWebSocketClientTransport } from 'murow/net/adapters/browser-websocket';
import { GameClient } from 'murow/netcode';
import { intents, rpcs, Position } from './shared/protocol';
import { predictions } from './shared/predictions';

const transport = new BrowserWebSocketClientTransport(`ws://${location.host}/ws`);

const world = new World({ maxEntities: 64, components: [Position] });
const loop = new GameLoop({ tickRate: 20, type: 'client' });
const client = new GameClient({
  world, loop, transport,
  protocol: { intents, rpcs },
});

client.use(predictions);

loop.events.on('tick', ({ input }) => {
  const dx = (input.keys['KeyD']?.down ? 1 : 0) - (input.keys['KeyA']?.down ? 1 : 0);
  const dy = (input.keys['KeyS']?.down ? 1 : 0) - (input.keys['KeyW']?.down ? 1 : 0);
  if (dx !== 0 || dy !== 0) client.sendIntent('move', { dx, dy });
  // sendIntent returns false until the server assigns an entity; the
  // engine drops the call rather than mis-firing the prediction.
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

Sent once per `server.assignEntity(peer, e)` call. See the
"Entity assignment" concept section below.
</details>

## Concepts

### Intents

Client-to-server messages. Define a schema, pass it to the
`GameClient` / `GameServer` constructor, and `sendIntent` is typed
against every name and payload.

```ts
import { defineIntents } from 'murow/netcode';
import { f32, u32 } from 'murow';

export const intents = defineIntents({
  move:   { dx: f32, dy: f32 },
  attack: { targetId: u32 },
});

const server = new GameServer({ protocol: { intents, rpcs }, /* ... */ });
const client = new GameClient({ protocol: { intents, rpcs }, /* ... */ });

client.sendIntent('move', { dx: 1, dy: 0 });
client.sendIntent('attack', { targetId: 42 });
```

### RPCs

Bidirectional messages outside the state-sync pipeline. Define a
schema, pass it to the `GameClient` / `GameServer` constructor, and
the send and receive APIs are typed against every name and payload.

```ts
import { defineRpcs } from 'murow/netcode';
import { u8, u16 } from 'murow';

export const rpcs = defineRpcs({
  matchStart:  { countdownSec: u8 },
  achievement: { id: u16 },
});

const server = new GameServer({ protocol: { intents, rpcs }, /* ... */ });
const client = new GameClient({ protocol: { intents, rpcs }, /* ... */ });

server.broadcastRpc('matchStart', { countdownSec: 3 });
server.sendRpc(peer, 'achievement', { id: 7 });

client.on('rpc', ({ name, args }) => { /* ... */ });
```

### Predictions

Shared logic that runs on both sides. Plug intents in, the handler map
is typed against them. Server applies authoritatively; client applies
locally and rolls back when the snapshot disagrees.

```ts
import { definePredictions } from 'murow/netcode';
import { intents, Position } from './protocol';

export const predictions = definePredictions(intents, {
  move: ({ dx, dy }, ctx) => {
    const pos = ctx.fields(Position);
    pos.x[ctx.entity] += dx * ctx.deltaTime;
    pos.y[ctx.entity] += dy * ctx.deltaTime;
  },
});

server.use(predictions);
client.use(predictions);
```

### Handlers

Server-side logic. Plug intents in, the handler map is typed against
them, the server invokes the matching handler per intent. 

> Same `ctx` as predictions, but includes `peer`, `clientTick`, `lagCompensated`.

```ts
import { defineHandlers } from 'murow/netcode';
import { intents, Ammo } from './protocol';

export const handlers = defineHandlers(intents, {
  shoot: (_, ctx) => {
    const ammo = ctx.fields(Ammo);
    if (ammo.count[ctx.entity] === 0) return;
    ammo.count[ctx.entity] -= 1;
  },
});

server.use(handlers);
```

Predictions and handlers can coexist on the same intent.

### Networked components

The `sync` block is a sending and receiving rule for the component's
data. With `sync`, every entity that has the component gets its data
packaged into outgoing snapshots and unpacked on receive.

> Without `sync`, the component stays local to the environment.

```ts
import { defineComponent, f32, u8 } from 'murow';
import { networked } from 'murow/netcode';

export const Position = defineComponent('Position', {
  schema: { x: f32, y: f32 },
  sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

export const Ammo = defineComponent('Ammo', {
  schema: { count: u8 },
  sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
});
```

Options:
- `rate` - how often it ships (`'every-tick'`, `'on-change'`, `{ every: N }`)
- `interest` - which peers receive it (`'global'` or a plugin name)
- `interp` - how the receiver smooths between packets (`'lerp'`, `'slerp'`, `'step'`, `'none'`)
- `snapThreshold` - distance beyond which the receiver snaps instead of smoothing

Pass the components to both `GameServer` and `GameClient` via the
`World` constructor; both ends need the same definitions.

```ts
const world = new World({ maxEntities: 64, components: [Position, Ammo] });
```

Not all options are wired up yet - see the "Not wired up yet" section
below.

### Entity assignment

Tells a client which entity in the world represents *them*. Used
mostly when a player connects: the server spawns their entity, calls
`assignEntity`, and the client learns its own id so it can wire input
to it.

```ts
// Server: on connect, spawn the player and tell the client.
server.on('connection', ({ peer }) => {
  const entityId = world.spawn();

  world.add(entityId, Position, { x: 0, y: 0 });
  server.assignEntity(peer, entityId);
});

// Client: remember the id and route input through it.
let me: number | null = null;
client.on('assigned', ({ entity }) => { me = entity; });

client.on('error', console.error);

const sent = client.sendIntent('move', { dx, dy });  // applies to `me` on both sides
```

`sendIntent` returns `false` if the server hasn't yet assigned and
delivered an entity id to the client. 

The assignment fires `client.on('assigned', ({ entity }) => ...)` and is also readable any
time as `client.assignedEntity`. The same blocked send also emits an
`'error'` event with `context: 'sendIntent'` for visibility.

The client auto-marks the assigned entity as predicted, so
reconciliation only rolls back state for entities the peer owns.

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

## Not wired up yet

Some `networked()` fields are in the type but not honored at runtime
yet. Setting them compiles; the component still syncs with default
behavior.

- `rate: 'on-change'` and `rate: { every: N }` behave as `'every-tick'`.
  To approximate `'on-change'`, only mutate the component when the
  value actually changed.
- `interest` is not read. Server plugins (`AoiGrid`, etc.) run their
  `filterSnapshot` against every dirty entity regardless of what each
  component says. To limit a component to a subset of peers today,
  write a plugin whose `filterSnapshot` inspects it.
- `interp: 'slerp'` falls through to `'lerp'`. `'lerp'`, `'step'`, and
  `'none'` work.
- `snapThreshold` is unread.

Interp dispatch is per-component, not per-field.

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

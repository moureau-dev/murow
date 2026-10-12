# Designing multiplayer with murow/netcode

`murow/netcode` gives you snapshot sync, prediction with rollback, jitter interpolation, and interest management on top of `murow`'s ECS and transports. The first half of this guide is about the decisions: what is an intent, what is an RPC, what is a networked component, what runs on both sides, what stays server-only, how peers are assigned entities, and how to tune the network. The API reference follows. The exhaustive per-symbol reference also lives in `packages/netcode/README.md`.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **Movement, aiming, and anything the client should feel immediately is an `intent`.** Inputs are intents, not RPCs.
2. **One-off events that are not input and not state are `RPCs`** — match start, chat, achievements, UI feedback.
3. **Long-lived per-entity state is a `networked()` component**, and every entity that needs it on the client must have `sync`.
4. **Deterministic logic that must feel local goes in `definePredictions`** (runs on both sides, replays on rollback). See the [determinism guide](./determinism.md).
5. **Authority, hit detection, and anything that reads the clock or does I/O goes in `defineHandlers`** (server-only, never replayed).
6. **Only networked components in a prediction.** A prediction that writes local-only state will be corrupted by rollback.
7. **The server is authoritative.** It applies intents itself; the client only predicts and reconciles.
8. **Peers are not entities.** Spawn an entity on connect and bind it with `server.assignEntity(peer, e)`; the client learns it via `'assigned'` / `client.assignedEntity`.
9. **Scope what peers receive with `networked().interest`** — `'global'` is never filtered (and forces its entity in); a plugin name (e.g. `AoiGrid`'s `name`) ships the component only for peers the plugin deems visible. When a previously-visible entity leaves interest (out of AOI, or despawned) the server ships a despawn, so the client removes it rather than holding a frozen copy.
10. **Sim tick rate is not render rate.** Run a fixed `tickRate`; render interpolates between fixed states.

## The decision model

Ask three questions in order: *does the client need to feel it now*, *is it per-entity state or a one-off message*, and *must the server alone decide it*.

### Intent vs RPC vs networked component

| you are sending | use | why |
|---|---|---|
| "I pressed left / I want to move / I aim here" | **intent** (`defineIntents`) | ordered, replayable, feeds predictions and rollback |
| "match starts in 3", "you got an achievement", chat | **RPC** (`defineRpcs`) | one-off, not input, not part of the state stream |
| "this entity has hp 40 and position (x,z)" | **networked component** | continuous per-entity state, snapshot-synced |
| "I want to buy item 42" | **RPC** to server | a request, not input; server decides the outcome |

Intents and RPCs are both typed by a schema map on each side. Intents carry a per-client monotonic sequence; the server applies them in order and acks them, which is what makes rollback safe. RPCs are fire-and-forget and have no ordering guarantees you should rely on.

A useful test: **if losing the message would desync the world, it is not an RPC.** RPCs are for presentation and lifecycle.

### Prediction vs handler

Both are registered with `server.use(...)`; only `definePredictions` is also registered with `client.use(...)`.

| logic | goes in | runs where |
|---|---|---|
| movement, dash, aim, local abilities the player must feel instantly | `definePredictions` | client **and** server; replayed on rollback |
| hitscan damage, loot rolls, spawns, economy, anything reading `Date.now()` | `defineHandlers` | server only |
| logic that mutates components the client predicts | `definePredictions` | both |
| logic that reacts to an intent but has no local counterpart | `defineHandlers` | server |

They coexist on the same intent. A `shoot` intent can have a prediction that plays the muzzle-flash state change and a handler that resolves the hit. The handler gets a superset `ctx` (`peer`, `clientTick`, `lagCompensated`).

Prediction rules are strict because the code is replayed. If it is not deterministic, it does not belong in `definePredictions` — push it to a handler. The full list of what breaks replay is in the [determinism guide](./determinism.md).

### Which components are networked, which stay local

A component is networked when it has a `sync: networked(...)` block; otherwise it is local to one environment and never appears in a snapshot.

Network these:

- Anything both sides simulate: `Position`, `Velocity`, `Facing`, `Health`, `Ammo`.
- Anything the client renders for other entities: team color, hero id, animation state.
- Any field a prediction writes. Predictions must write networked state so rollback can restore it.

Keep these local:

- Camera state, input buffers, UI selection, hover, local particle handles.
- Renderer handles and DOM overlays (they live in `SlotStore`, not the ECS).
- Server-only bookkeeping (match timers, spawn budgets).

The client and server must construct their `World` with the **same component list**. A component that is networked on one side and missing on the other cannot sync.

### Authority and entity ownership

The server is the single authority. The client predicts, but the server's snapshot wins; when the client's prediction disagrees past tolerance it rewinds and replays its unacked intents. There is no client-authoritative mode.

Ownership is a server-side binding, not a component. On connect the server spawns the player entity and calls `assignEntity`. That call:

- fills `ctx.entity` for that peer's intents (predictions and handlers),
- sends the client an assignment frame,
- makes the client auto-mark that entity as predicted, so reconciliation only rolls back what the peer owns.

Server-spawned entities (projectiles, NPCs, pickups) are **not** assigned to anyone. They replicate to clients purely by being dirty and networked. Clients tell "mine vs theirs" apart with `client.assignedEntity`.

## Worked examples

### Top-down movement — intent + shared prediction + networked component

One component, one intent, one prediction shared by both sides. This is the shape almost everything else extends.

```ts
// shared/protocol.ts
import { defineComponent, f32 } from 'murow';
import { defineIntents, defineRpcs, networked } from 'murow/netcode';

export const Position = defineComponent('Position', {
  schema: { x: f32, y: f32 },
  sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp' }),
});

export const intents = defineIntents({ move: { dx: f32, dy: f32 } });
export const rpcs = defineRpcs({});
```

```ts
// shared/predictions.ts — runs on both sides, replayed on rollback
import { definePredictions } from 'murow/netcode';
import { intents, Position } from './protocol';

export const predictions = definePredictions(intents, {
  move: ({ dx, dy }, ctx) => {
    const pos = ctx.fields(Position);                 // auto-marks dirty
    pos.x[ctx.entity] += dx * ctx.deltaTime;          // fixed deltaTime, deterministic
    pos.y[ctx.entity] += dy * ctx.deltaTime;
  },
});
```

The client applies it immediately (feels responsive) and the server applies the same function authoritatively. The health/ammo variant is the classic split: position moves in a prediction, damage resolves in a handler.

### Hitscan — handler + lag compensation

Damage is server-only and must be judged against where the shooter saw the world, not where the server is now.

```ts
// shared/handlers.ts
import { defineHandlers } from 'murow/netcode';
import { intents, Health, Position } from './protocol';

export const handlers = defineHandlers(intents, {
  shoot: ({ fromX, fromZ, dirX, dirZ }, ctx) => {
    ctx.lagCompensated(() => {
      // The world is rewound to ctx.clientTick for the duration of this call.
      // Run the raycast and apply damage against historical positions.
      const hp = ctx.world.fields(Health);
      hp.current[victimId] -= damage;
      ctx.markDirty(Health, victimId);                // cross-entity write
    });
  },
});
```

Register the plugin once at server setup; without it `lagCompensated` is a no-op pass-through:

```ts
server.use(new LagCompensation({ tickRate: 20, historyMs: 500, components: [Position] }));
```

`LagCompensation` only rewinds the components you register with it. Anything not listed is read at the current tick. The history is a preallocated ring of binary frames, so steady-state ticks and rewinds allocate nothing, but its memory scales with `maxEntities × ringSize × bytesPerEntity`. Register one instance per server, not per match or per peer.

### Area of interest — filtering what each peer receives

Full snapshots of a thousand entities do not scale. `AoiGrid` filters each peer's snapshot to entities within `radius + hysteresisRadius` of that peer's assigned entity. The server tracks each peer's visible set and sends a despawn when an entity leaves it (including a peer-driven leave), so clients never keep a stale entity on screen.

Interest plugins are **independent, not composed**: each plugin is consulted against the candidate set on its own, and a component's `sync.interest` picks the one plugin that governs it. So one entity can ship different components to different peers (e.g. `Position` under an `AoiGrid`, a team-only component under a visibility plugin). A `'global'` component is never filtered and forces its entity into the snapshot — mark spatially-filtered components with the AOI plugin's name, not `'global'`, or they leak.

On connect the server sends a **schema fingerprint** (derived from the synced components, or the `schemaFingerprint` option); a client whose schema differs fires an `'error'` with context `'schema-fingerprint'` — a cheap guard against client/server layout drift.

Two bandwidth levers: `networked({ quantize: { x: { min, max, bits } } })` sends a field as an 8/16-bit integer over a range (store stays `f32`; e.g. a position `f32` → 2 bytes), and the server's `snapshot.maxBytesPerPeer` caps each peer's entity body, sending highest-`priority` entities first and deferring the rest to the next tick (they stay dirty).

Both `GameServer` and `GameClient` accept an optional `debug?: boolean | Logger` (a `murow/core/logger` `Logger`, or `true` for the console logger) for connect/disconnect/kick/interest-leave diagnostics.

```ts
server.use(new AoiGrid({
  name: 'aoi',
  cellSize: 32,             // reserved for grid acceleration; v1 scans naively
  radius: 50,
  hysteresisRadius: 4,      // boundary slack to stop despawn flicker
  positionComponent: Position,
}));
```

Two things to know before you reach for it:

- **`networked().interest` is honored.** Each plugin is consulted against the full dirty set, and every component is gated by its own `interest`: `'global'` forces its entity into the snapshot, while a plugin-name interest ships the component only when that plugin deems the entity visible. One entity can therefore ship different components to different peers.
- Entities without the `positionComponent` pass through unfiltered. That is the escape hatch for genuinely global state (scoreboards, match timers) — keep it on a component that is not the AOI position component.

### Tests — memory and virtual transports

Real sockets are slow and nondeterministic. Two bundled transports let you drive the netcode in-process:

```ts
import { MemoryServerTransport } from 'murow/net';

const serverTransport = new MemoryServerTransport();
const server = new GameServer({ world, loop, transport: serverTransport, protocol: { intents, rpcs } });
const { client: clientTransport } = serverTransport.connectClient();
const client = new GameClient({ world: clientWorld, loop: clientLoop, transport: clientTransport, protocol: { intents, rpcs } });
```

`MemoryServerTransport` is a microtask pair with no clock: good for fast integration tests of assignment, intents, and reconciliation.

`VirtualServerTransport` (also from `murow/net`) simulates latency, jitter, loss, and reorder with a seedable `VirtualNetwork` you advance yourself. Use it to reproduce the ugly cases — reordered snapshots, bursts of intents, intermittent senders — deterministically:

```ts
import { VirtualServerTransport, VirtualNetwork } from 'murow/net';

const vnet = new VirtualNetwork();
const transport = new VirtualServerTransport({
  vnet,
  seed: 0x5eed,
  cfg: { baseLatencyMs: 80, jitterMs: 20, lossChance: 0.02, reorderChance: 0.05, reorderSkewMs: 30 },
});
// ...then drive time yourself:
vnet.advance(16);
```

A fixed seed reproduces the same conditions, and each peer gets an independent RNG stream so one peer's traffic cannot perturb another's. This is how you turn "sometimes it stutters" into a repeatable test.

## Tuning interpolation

Snapshot interpolation renders the world slightly in the past, at a delay behind the newest snapshot, so it can glide between received states instead of showing each packet as a jump. The client options name four knobs:

- `delay` — ms behind the newest snapshot. Lower is more responsive, higher absorbs more jitter.
- `staleWindow` — ms gap before buffered history is dropped as stale.
- `maxDesync` — desync past which the play-out clock hard-snaps instead of warping.
- `maxBridgeGap` — largest data gap a peer may have before its value is held instead of interpolated across.

Defaults are `delay: 100`, `staleWindow: delay * 2 + 100`, `maxDesync: 500`, `maxBridgeGap: 250`. All four are tunable at runtime, and the recommended pattern is to probe RTT on a period and set the delay from it — a couple of ticks of buffer beyond half the RTT:

```ts
const TICK_MS = loop.ticker.intervalMs;
const SAFETY_TICKS = 2;

client.on('pong', ({ rtt }) => {
  const delay = rtt / 2 + SAFETY_TICKS * TICK_MS;
  client.setInterpolationDelay(delay);
  client.interpBuffer.setStaleWindow(delay * 2 + 100);
});

// Probe on the sim tick, never with setInterval:
loop.events.on('tick', ({ tick }) => {
  if (tick % (loop.ticker.rate * 2) === 0) client.ping();
});
```

`client.rttMs` is the last measurement (`null` until the first pong). Drive periodic probes off `tick % (rate * seconds) === 0` rather than a timer: it stays in step with the loop, stops when the loop pauses, and leaks nothing.

## Entity assignment and reconnection

Assignment is explicit and one-directional: the server calls `assignEntity`, the client receives `'assigned'`. `client.sendIntent` returns `false` until that frame arrives (and emits an `error` with `context: 'sendIntent'`), so a client can safely call it before it knows its entity — the engine drops the call instead of mis-firing the prediction.

```ts
server.on('connection', ({ peer }) => {
  const e = world.spawn();
  world.add(e, Position, { x: 0, y: 0 });
  server.assignEntity(peer, e);
});

server.on('disconnection', ({ peer }) => {
  if (peer.entity !== -1 && world.isAlive(peer.entity)) world.despawn(peer.entity);
});
```

If the assignment frame lands before the matching spawn, the client buffers it and resolves on the spawn.

### Reconnection

Opt in on both sides. The server holds a dropped peer's session — its assigned
entity and intent-ack cursor — for `reconnection.graceMs` (default 10000 ms);
the client presents its token on connect so a reconnect resumes the session
instead of spawning a new peer.

```ts
const server = new GameServer({ world, loop, transport, protocol,
  reconnection: { graceMs: 10000 } });
const client = new GameClient({ world, loop, transport, protocol,
  reconnection: true });
```

On transport open the client sends its token — `client.sessionToken`, learned
from the server, or supplied as `reconnection: { token }` to resume across a
full reload. The server answers `'reconnection'` (resumed) or `'connection'`
(new), re-sends the assignment and a full baseline, and the client fires
`'reconnected'`.

Server-side, a session is *held* on `'suspended'` and only finalized on
`'disconnection'` — which fires when the grace lapses (`reason:
'reconnect-timeout'`), on a kick, or when reconnection is off. Keep the entity
alive on `'suspended'`; despawn on `'disconnection'`.

```ts
server.on('suspended',    ({ peer }) => { /* keep peer.entity alive */ });
server.on('reconnection', ({ peer }) => { /* migrate per-peer state */ });
server.on('disconnection',({ peer }) => { if (peer.entity !== -1) world.despawn(peer.entity); });
```

The server also enforces liveness: `kick.ackTimeout` (default 2000 ms) force-closes a transport that stops acking, and `server.kick(peer, reason)` soft-kicks gracefully.

## Tick rates and why sim tick ≠ render rate

Both `GameServer` and `GameClient` read their rate from `loop.ticker.rate`. Snapshot scheduling, `ctx.deltaTime`, and lag-compensation history sizing all derive from it. When predictions are in use, **server and client must use the same tick rate** — predictions assume both sides advance by the same `deltaTime`.

The simulation tick and the render rate are deliberately separate. A client loop commonly runs at 20 ticks/s while the browser paints at 60+ Hz. The world only changes on ticks; the renderer interpolates between the last two fixed states (`renderer.storePreviousState()` + `render(alpha)`). This is why a low tick rate still looks smooth:

```ts
const loop = new GameLoop({ tickRate: 20, type: 'client' });    // sim at 20 Hz
loop.events.on('tick',    ({ input }) => sendInputs(input));    // user sim logic
loop.events.on('render',  ({ alpha })  => renderer.render(alpha)); // at refresh rate
```

Do not build a `requestAnimationFrame` simulation loop, and do not schedule game logic with `setTimeout`/`setInterval` — both break replay. The loop owns ticks and rendering; subscribe to its events.

Lower tick rates cut bandwidth and CPU but widen the interpolation delay needed; higher rates cost more per second and make `tickRate` mismatches between client and server more punishing. Pick one rate, share it, and treat it as fixed.

## API reference

The design sections above explain *why*; this is *what*. Everything here mirrors the exported surface.

### `networked()` — snapshot participation

`networked(spec)` is an identity helper that type-checks the `sync` block on `defineComponent`. A plain object literal also works, but the helper catches typos (`'evry-tick'`, `interest: 42`) at compile time.

```ts
type InterpolationMode = 'lerp' | 'slerp' | 'step' | 'none';
type SyncRate          = 'every-tick' | 'on-change' | { every: number };  // { every: N } = every Nth tick
type InterestRule      = 'global' | (string & {});                       // plugin name, or 'global'

interface SyncSpec {
  rate: SyncRate;
  interest: InterestRule;
  interp?: InterpolationMode;   // default 'lerp' for ALL types; set 'step' yourself on ids/flags
  snapThreshold?: number;       // distance beyond which the client snaps instead of smoothing
}
```

```ts
import { defineComponent, f32, u8, u16 } from 'murow';
import { networked } from 'murow/netcode';

export const Position = defineComponent('Position', {
  schema: { x: f32, z: f32 },
  sync: networked({ rate: 'every-tick', interest: 'global', interp: 'lerp', snapThreshold: 0.5 }),
});

export const Color = defineComponent('Color', {
  schema: { r: u8, g: u8, b: u8 },
  sync: networked({ rate: 'on-change', interest: 'global', interp: 'step' }),
});

export const Cosmetic = defineComponent('Cosmetic', {
  schema: { hatId: u16 },
  sync: networked({ rate: { every: 10 }, interest: 'global' }),   // sync at most once per 10 ticks
});
```

Not every field is honored at runtime yet. Setting them compiles; the component still syncs with default behavior:

| field | value | honored | behavior today |
|---|---|---|---|
| `rate` | `'every-tick'` | yes | sent every snapshot tick if dirty |
| `rate` | `'on-change'` | yes | sent only when the entity is dirty for this component since the last snapshot |
| `rate` | `{ every: N }` | yes | sent on change, or on `tick % N === 0` |
| `interest` | any | no | server plugins run `filterSnapshot` on every dirty entity regardless |
| `interp` | `'lerp'`, `'step'`, `'none'` | yes | per-component dispatch on the client interpolation buffer |
| `interp` | `'slerp'` | no | falls through to `'lerp'` |
| `snapThreshold` | number | no | unread |

### Message schemas — `defineIntents`, `defineRpcs`

```ts
export const intents = defineIntents({
  move:  { dx: f32, dz: f32 },
  shoot: { fromX: f32, fromZ: f32, dirX: f32, dirZ: f32 },
});

export const rpcs = defineRpcs({
  matchStart: { countdownSec: u16 },
});
```

Intents are client-to-server. Kinds are auto-assigned in insertion order starting at 1 (0 is reserved for engine control frames). TypeScript inference flows into `client.sendIntent` and the predictions/handlers maps.

RPCs are bidirectional: one `defineRpcs` map serves both directions (`server.sendRpc` / `server.broadcastRpc` and `client.sendRpc`, received via `server.on('rpc')` / `client.on('rpc')`). The `'rpc'` payload is a discriminated union over the schema — narrow on `name` and `payload` is typed for that RPC. The method names `__murow_ping` and `__murow_pong` are reserved; the engine auto-registers them to drive `client.ping()` / the `'pong'` event. Do not define RPCs with those names.

### Predictions and handlers — the `ctx` surface

```ts
interface PredictionContext {
  world: World;
  entity: Entity;          // server-assigned entity for the peer that sent the intent
  tick: number;
  deltaTime: number;       // seconds since previous tick
  rng: SimpleRNG;          // deterministic, seeded per tick, replayed identically on both sides

  // RAW-speed typed-array access for ctx.entity. Same frozen bundle as
  // world.fields(C), and auto-marks ctx.entity dirty for networked components
  // so snapshots pick up the write. Zero allocations on the hot path.
  fields<T extends object>(component: Component<T>): ComponentFields<T>;

  // Explicit dirty mark. Use when bypassing ctx.fields (e.g. reaching into
  // ctx.world.fields directly) or marking a cross-entity write. Accepts a
  // single component or an array; entity defaults to ctx.entity. No-ops for
  // unsynced or unregistered components.
  markDirty(component: Component<any>, entity?: Entity): void;
  markDirty(components: ReadonlyArray<Component<any>>, entity?: Entity): void;
}

type PredictionFn<P> = (payload: P, ctx: PredictionContext) => void;

function definePredictions<I extends IntentSchemaMap>(
  intents: DefinedIntents<I>,
  map: { [K in keyof I]?: PredictionFn<IntentPayload<I, K>> },
): DefinedPredictions<I>;
```

```ts
interface Peer {
  peerId: string;
  entity: Entity | -1;     // -1 until server.assignEntity is called
}

interface ServerHandlerContext extends PredictionContext {
  peer: Peer;
  clientTick: number;                       // tick the client claimed when sending
  lagCompensated<T>(fn: () => T): T;        // rewind world to clientTick, run fn, restore
}

type HandlerFn<P> = (payload: P, ctx: ServerHandlerContext) => void;

function defineHandlers<I extends IntentSchemaMap>(
  intents: DefinedIntents<I>,
  map: { [K in keyof I]?: HandlerFn<IntentPayload<I, K>> },
): DefinedHandlers<I>;
```

The recommended prediction body uses `ctx.fields` (zero allocation, auto dirty-tracking, RAW-speed reads/writes). The `world.update({...})` path still works but is ~6x slower in tight loops because it allocates the partial-update object and re-resolves the component every call; use it for clarity in non-hot code.

```ts
export const predictions = definePredictions(intents, {
  move: ({ dx, dz }, ctx) => {
    if (!ctx.world.has(ctx.entity, Position)) return;
    const pos = ctx.fields(Position);   // typed: { x: Float32Array, z: Float32Array }
    pos.x[ctx.entity] += dx * MOVE_SPEED * ctx.deltaTime;
    pos.z[ctx.entity] += dz * MOVE_SPEED * ctx.deltaTime;
  },
});
```

Determinism rules (predictions replay during rollback, so the same input must produce the same output):

1. No `Math.random()`. Use `ctx.rng`.
2. No `Date.now()` / `performance.now()`. Use `ctx.tick` or `ctx.deltaTime`.
3. No network, audio, file I/O, or DOM.
4. No reads from module-level mutable state. Keep state in components.
5. Write only to networked components. Touching local-only state from a prediction lets rollback corrupt UI.

Cross-entity writes use `ctx.markDirty` so the snapshot pipeline picks up the change:

```ts
// A damage handler that hits the victim, not the attacker.
const hp = ctx.world.fields(Health);
hp.current[targetId] -= damageDealt;
ctx.markDirty(Health, targetId);

// Batched multi-component cross-entity write (one dirty mark instead of two).
const armor = ctx.world.fields(Armor);
hp.current[targetId] -= damageDealt;
armor.value[targetId] -= 1;
ctx.markDirty([Health, Armor], targetId);
```

Handlers inherit `fields` and `markDirty` from `PredictionContext` and are server-only by design — `client.use(handlers)` is a compile error. `lagCompensated` only rewinds components registered with the `LagCompensation` plugin; without it, it is a no-op pass-through.

### `GameServer`

```ts
interface GameServerOptions<I, R> {
  world: World;
  loop: GameLoop<any>;
  transport: ServerTransportAdapter<TransportAdapter>;
  protocol: { intents: DefinedIntents<I>; rpcs: DefinedRpcs<R> };
  snapshot?: {
    rate?: number;              // snapshots per second, clamped to tickRate. Default: min(20, tickRate)
  };
  kick?: {
    ackTimeout?: number;        // ms with no ack before forcing transport close. Default: 2000
  };
  schemaFingerprint?: string;   // reserved version tag — accepted but not enforced; mismatched clients are NOT kicked yet
}
```

```ts
class GameServer<I, R> {
  use(bundle: DefinedPredictions<I>): this;          // overloaded — also takes DefinedHandlers / ServerPlugin
  use(bundle: DefinedHandlers<I>): this;
  use(plugin: ServerPlugin): this;

  assignEntity(peer: Peer, entityId: Entity): void;  // claim an entity for a peer; client gets 'assigned'
  sendRpc<K extends keyof R & string>(peer: Peer, name: K, payload: RpcPayload<R, K>): void;
  broadcastRpc<K extends keyof R & string>(name: K, payload: RpcPayload<R, K>): void;

  // Soft-kick: send a KICK frame, wait kick.ackTimeout (default 2000ms) for the
  // client's ack, then force-close the transport. The client gets 'kicked'.
  kick(peer: Peer, reason: string): void;
}
```

Server events:

```ts
server.on('connection',     ({ peer })                          => {});
server.on('disconnection',  ({ peer, reason })                  => {});
server.on('intent',         ({ peer, kind, name, payload, tick }) => {});  // observe-only telemetry
server.on('intent-failed',  ({ peer, kind, reason })            => {});
server.on('rpc',            ({ peer, name, payload })           => {});  // discriminated union; narrow on `name`
server.on('snapshot',       ({ peer, tick, byteSize })          => {});
server.on('error',          ({ error, context })                => {});
```

`server.on('intent')` is observe-only for logging/telemetry; gameplay goes in `defineHandlers`, and both coexist. Server-spawned non-player entities (projectiles, NPCs, pickups) are never `assignEntity`'d — they replicate to every peer through the normal snapshot path just by being dirty (subject to interest filtering). Clients tell "mine vs. theirs" apart with `client.assignedEntity`. There is no separate API: an unowned networked entity is simply one you never assigned.

### `GameClient`

```ts
// How snapshots become rendered peer state: a `kind` + that strategy's options.
type PeerRenderStrategyConfig =
  | { kind: 'snapshot-interpolation'; delay?: number; staleWindow?: number; maxDesync?: number; maxBridgeGap?: number }
  | { kind: 'extrapolation';          maxExtrapolationMs?: number }
  | { kind: 'hybrid';                 delay?: number; maxExtrapolationMs?: number; staleWindow?: number; maxDesync?: number; maxBridgeGap?: number };
// ...or a `PeerRenderStrategy` instance (subclass record/apply/clear + tuners) for a custom strategy.

interface GameClientOptions<I, R> {
  world: World;
  loop: GameLoop<any>;
  transport: TransportAdapter;
  protocol: { intents: DefinedIntents<I>; rpcs: DefinedRpcs<R> };
  strategy?: PeerRenderStrategyConfig | PeerRenderStrategy;
  prediction?: {
    bufferSize?: number;   // max unacked predictions for rollback. Default 64
  };
}
```

```ts
class GameClient<I, R> {
  // Local entity the server assigned to this peer, or null before the assignment frame.
  readonly assignedEntity: Entity | null;

  // true when sent + predicted locally; false when the name isn't in the schema
  // or assignedEntity is still null. Both blocked paths emit 'error' (context: 'sendIntent').
  sendIntent<K extends keyof I & string>(name: K, payload: IntentPayload<I, K>): boolean;

  sendRpc<K extends keyof R & string>(name: K, payload: RpcPayload<R, K>): void;
  use(predictions: DefinedPredictions<I>): this;

  ping(): void;                             // probe; result fires on 'pong'
  readonly rttMs: number | null;            // last measurement, null until the first pong
  getLocalTick(): number;
  getPredictionDepth(): number;
  readonly interpolationDelay: number;      // current buffer delay in ms
  setInterpolationDelay(ms: number): void;  // same as interpBuffer.setDelay
  setMaxDesync(ms: number): void;
  setMaxBridgeGap(ms: number): void;

  // Exposed for runtime tuning; the tuning example retunes it from measured RTT in the 'pong' handler.
  readonly interpBuffer: PeerRenderStrategy;
}

abstract class PeerRenderStrategy {
  setDelay(delayMs: number): void;          // same as client.setInterpolationDelay
  setStaleWindow(staleWindowMs: number): void;
  setMaxDesync(maxDesyncMs: number): void;
  setMaxBridgeGap(maxBridgeGapMs: number): void;
  clear(): void;                            // drop buffered history (hard teleport / scene change)
}
```

Client events:

```ts
client.on('connected',    ()                                    => {});
client.on('disconnected', ({ reason })                          => {});
client.on('kicked',       ({ reason })                          => {});
client.on('snapshot',     ({ tick, byteSize })                  => {});
client.on('rpc',          ({ name, payload })                   => {});  // discriminated union; narrow on `name`
client.on('spawn',        ({ entity, components })              => {});
client.on('despawn',      ({ entity })                          => {});
client.on('reconciled',   ({ rewindTick, replayed })            => {});  // fires after rollback + replay
client.on('assigned',     ({ entity })                          => {});  // server assigned us this entity
client.on('pong',         ({ rtt })                             => {});  // round-trip time in ms
client.on('error',        ({ error, context })                  => {});
```

`rewindTick` carries the server's contiguous-applied intent sequence (not the game tick) — the cut-off the reconciler used to drop history. Every networked entity reaches the client through `'spawn'` — your own player, other players, and server-spawned NPCs/projectiles alike. Tell yours apart with `client.assignedEntity` (or the id from the `'assigned'` event). If the `assigned` frame lands before the matching spawn, the client buffers it and resolves on the spawn.

Event payload shapes are exported as `ServerEventPayloads` and `ClientEventPayloads`; both `GameServer` and `GameClient` extend `EventSystem<...>` with them, so `on()` is fully typed. Import the payload types to type a handler outside the class:

```ts
import type { ServerEventPayloads, ClientEventPayloads, Peer } from 'murow/netcode';

function logIntent({ peer, name, payload }: ServerEventPayloads['intent']) { /* ... */ }
```

Connection lifecycle (typical):

```
client connects   → server.on('connection',  { peer })
client receives   → 'connected', then 'spawn' for every existing entity
server assigns    → server.assignEntity(peer, e) → client.on('assigned', { entity: e })
client sends      → client.sendIntent('move', { dx, dz })
                    → prediction runs immediately on client (predicted entity)
                    → server runs same prediction authoritatively next tick
                    → next snapshot reconciles (rollback + replay if needed) → 'reconciled'
client disconnect → server.on('disconnection', { peer, reason })
```

### Plugins

```ts
interface ServerPlugin {
  readonly name: string;
  onMount?(server: GameServer<any, any>): void;
  onUnmount?(server: GameServer<any, any>): void;
  onTick?(world: World, deltaTime: number): void;
  onIntent?(peer: Peer, kind: number, name: string, payload: unknown, ctx: ServerHandlerContext): void;
  filterSnapshot?(peer: Peer, world: World, dirtyEntities: ReadonlyArray<Entity>, out: Entity[]): void;
  onDisconnect?(peer: Peer): void;
}

interface ClientPlugin {
  readonly name: string;
  onMount?(client: GameClient<any, any>): void;
  onUnmount?(client: GameClient<any, any>): void;
  onTick?(world: World, deltaTime: number): void;
  onSnapshot?(tick: number): void;
}
```

Register with `server.use(plugin)` / `client.use(plugin)`. Plugins compose in registration order — `filterSnapshot` calls chain (each pushes into the same `out` array).

`AoiGrid` options:

```ts
interface AoiGridOptions {
  name?: string;                                              // Default 'aoi'
  cellSize: number;                                           // reserved for grid acceleration; v1 scans naively
  radius: number;                                             // AOI radius (world units)
  hysteresisRadius?: number;                                  // extra despawn slack. Default 0
  positionComponent: Component<{ x: number; y: number }>;     // any 2D position component
}
```

`LagCompensation` options:

```ts
interface LagCompensationOptions {
  name?: string;                 // Default 'lag-compensation'
  tickRate: number;
  historyMs?: number;            // how far back to retain. Default 500
  components: Component<any>[];  // components whose history is recorded
}

class LagCompensation {
  rewind<T>(clientTick: number, fn: () => T): T;
}
```

History is a ring of preallocated binary frames sized from `maxEntities × ((historyMs / 1000 × tickRate) + 1)`; steady-state ticks and rewinds allocate nothing. Register one instance per server at setup, never per match or per peer.

Writing your own plugin:

```ts
import type { ServerPlugin } from 'murow/netcode';

class TelemetryPlugin implements ServerPlugin {
  readonly name = 'telemetry';
  onMount(server)                          { /* setup */ }
  onTick(world, deltaTime)                 { /* per-tick work */ }
  onIntent(peer, kind, name, payload, ctx) { /* every dispatched intent */ }
  filterSnapshot(peer, world, dirty, out)  { for (const e of dirty) out.push(e); }
  onDisconnect(peer)                       { /* cleanup */ }
}

server.use(new TelemetryPlugin());
```

### Wire formats and the low-level codec

`GameServer` and `GameClient` already drive the codec. Use `encodeDelta` / `decodeDelta` directly only for a custom snapshot pipeline (recording a replay file, piping snapshots through a non-WebSocket transport, or a custom interest layer). The encoder and decoder must agree on component order and mask-word count — they define the bitmask layout.

```ts
import { encodeDelta, decodeDelta, type DecodedDelta } from 'murow/netcode';

function encodeDelta(
  world: World,
  tick: number,
  entities: number[],                 // server-side entity ids to pack (the dirty set)
  components: Component<any>[],        // the component registry, in a stable order
  numMaskWords: number,               // ceil(components.length / 32)
  despawned?: number[],               // default []
  clientAckTick?: number,             // default 0
  includeComponent?: (entity: number, component: Component<any>) => boolean,  // per-(entity, component) send filter. default () => true
): Uint8Array;

function decodeDelta(
  world: World,
  buf: Uint8Array,
  components: Component<any>[],        // SAME order/length the encoder used
  numMaskWords: number,               // SAME value
  ensureEntity: (serverEntityId: number, present: Component<any>[]) => number,  // map server id -> local id, spawning if needed
  shouldApply?: (localEntity: number) => boolean,   // default () => true; false skips overwriting (e.g. your own predicted entity)
  pool?: SnapshotValuePool,                          // optional: recycle the decoded Map/rows/value objects (see SnapshotPool)
): DecodedDelta;

interface DecodedDelta {
  tick: number;
  clientAckTick: number;
  entityIds: number[];                // local ids (post-ensureEntity)
  serverEntityIds: number[];          // ids as they were on the wire
  despawnedServerIds: number[];       // server ids to despawn locally
  valuesByServerEntity: Map<number, (Record<string, any> | null)[]>;
  // row[ci] is the decoded value for `components[ci]` (same order as the decode call); null when absent.
}
```

Wire format (already validated by the codec — do not hand-construct):

```
snapshot header  : tick u32 | clientAckTick u32 | entityCount u16 | despawnCount u16
snapshot entities: repeated [ entityId u32 | bitmask u32 * N | fields packed by schema ]
snapshot despawns: repeated [ entityId u32 ]
intent           : [type=0x01][sequence u32][encoded intent]
assignment       : [type=0x84][serverEid u32]
```

`clientAckTick` is the highest **contiguous-applied intent sequence** the server has applied for the receiving peer (the field name is historical — it carries a per-send sequence, not a game tick). The reconciler uses it to drop confirmed predictions; server and client tick counters are independent.

Each `sendIntent` increments a per-client monotonic sequence (never reused, never skipped). The server applies intents in sequence order and only advances `clientAckTick` once every prior sequence has been applied, so the client's prediction-history cut-off is safe under reorder, packet loss, or skipped game ticks.

### Transports

Implement `TransportAdapter` from `murow`. Test transports live in `murow/net`:

- `MemoryServerTransport` — in-process server/client pair over microtasks, no clock. `connectClient()` returns `{ client, peerId }`. Good for fast integration tests of assignment, intents, and reconciliation.
- `VirtualServerTransport` — simulated latency, jitter, loss, and reorder; seeded and deterministic. You drive a `VirtualNetwork` clock with `vnet.advance(ms)`.

```ts
import { MemoryServerTransport, VirtualServerTransport, VirtualNetwork } from 'murow/net';

class MemoryServerTransport implements ServerTransportAdapter<MemoryPeerTransport> {
  connectClient(): { client: TransportAdapter; peerId: string };   // spawn a paired client transport
  onConnection(handler: (peer: MemoryPeerTransport, peerId: string) => void): void;
  onDisconnection(handler: (peerId: string) => void): void;
  getPeer(peerId: string): MemoryPeerTransport | undefined;
  getPeerIds(): string[];
  close(): void;
}
```

Murow's WebSocket transports (`BunWebSocketServerTransport`, browser `BrowserWebSocketClientTransport`) work directly with `GameServer` / `GameClient`. The layer assumes ordered delivery; WebSocket over TCP satisfies that, UDP would need its own ordering/reliability layer. The [testing guide](./testing.md) covers driving the test transports headlessly.

## Gotchas

- **`interest` is wired up.** `networked({ interest: 'aoi' })` ships the component only for peers the plugin named `'aoi'` (an `AoiGrid`) deems visible; `'global'` is never filtered and forces the entity into the snapshot.
- **`interp: 'slerp'` is not wired up.** It falls through to `'lerp'`. `'lerp'`, `'step'`, and `'none'` work. Interp dispatch is per-component, not per-field, so put discrete fields (ids, flags) on a `'step'` component rather than mixing them into a `'lerp'` one.
- **`snapThreshold` is not wired up.** It is in the type and unread. Use the client-level `maxDesync` and `maxBridgeGap` knobs for snap-vs-smooth behavior.
- **Predictions must write networked components only.** Rollback restores networked state; a prediction that touched local UI leaves it corrupted. Drive UI from networked state.
- **`ctx.fields(C)` marks dirty; `ctx.world.fields(C)` does not.** If you reach into the world directly, call `ctx.markDirty(C, entity)` — including for a different entity (`ctx.markDirty(Health, victimId)`). Cross-entity writes that skip this never reach the snapshot.
- **`lagCompensated` is a no-op without the plugin**, and only rewinds components registered with `LagCompensation`. Without registration you are hitting the live world and calling it lag compensation.
- **`on('intent')` is telemetry, not gameplay.** It is observe-only; gameplay handlers are registered with `defineHandlers`. Both fire, so do not apply effects in the event.
- **`clientAckTick` is an intent sequence, not a game tick.** Server and client tick counters are independent; the reconciler uses the ack sequence as the prediction-history cut-off. The `'reconciled'` event's `rewindTick` carries the same sequence.
- **Ordered delivery is assumed.** WebSocket over TCP is fine. If you write a UDP transport, implement your own ordering/reliability layer first.
- **A queuing custom transport must copy buffers in `send()`.** The engine may reuse the underlying memory.
- **Do not construct `LagCompensation` per match or per peer.** It is one ring per server, sized from `maxEntities` and `historyMs`.
- **`defineRpcs` reserves `__murow_ping` and `__murow_pong`.** The engine auto-registers them to drive `client.ping()` / the `'pong'` event; do not define RPCs with those names.

## Quick reference

| decision | choice |
|---|---|
| player input the client must feel now | `defineIntents` → `definePredictions` |
| one-off not-input, not-state event | `defineRpcs` (`sendRpc` / `broadcastRpc`) |
| continuous per-entity state | networked component (`sync: networked(...)`) |
| authoritative-only logic (damage, spawns, I/O) | `defineHandlers` |
| local-only state (camera, UI, handles) | plain component with **no** `sync` |
| who decides the truth | server (client predicts, server reconciles) |
| bind a player to an entity | `server.assignEntity(peer, e)`; read `client.assignedEntity` |
| limit what peers see | `AoiGrid` plugin; forget `interest` for now |
| hitscan against the shooter's view | `LagCompensation` + `ctx.lagCompensated` |
| control interpolation smoothness | `delay` / `staleWindow` / `maxDesync` / `maxBridgeGap` |
| probe latency | `client.ping()` on the tick → `'pong'` → `client.setInterpolationDelay(...)` |
| test without sockets | `MemoryServerTransport` (fast), `VirtualServerTransport` (lossy, seedable) |
| production transports | `BunWebSocketServerTransport` / `BrowserWebSocketClientTransport` |
| sim vs render | fixed `tickRate` for sim; interpolate at render rate |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



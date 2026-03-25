# Protocol Layer

Minimalist primitives for networked multiplayer games. Intents, snapshots, and RPCs - you handle the rest.

## What You Get

1. **IntentRegistry** - Register, encode, decode intents with zero allocations (Client → Server inputs)
2. **Snapshot<T>** - Type-safe delta updates (Server → Client state sync)
3. **RpcRegistry** - Remote procedure calls for one-off events (Bidirectional)
4. **applySnapshot()** - Deep merge snapshot updates into state

That's it. No loops, no queues, no storage - just the codec layer.

## Quick Start

### 1. Define Your Intent Kinds

```ts
// Define all your intent kinds in one place
enum IntentKind {
  Move = 1,
  Shoot = 2,
  Jump = 3,
}
```

### 2. Define Intents with Type-Safe Schemas

```ts
import { defineIntent } from "./protocol/intent";
import { BinaryCodec } from "./core/binary-codec";

// kind and tick are added automatically!
const MoveIntent = defineIntent({
  kind: IntentKind.Move,
  schema: {
    dx: BinaryCodec.f32,
    dy: BinaryCodec.f32,
  }
});

const ShootIntent = defineIntent({
  kind: IntentKind.Shoot,
  schema: {
    targetId: BinaryCodec.u32,
  }
});

// Extract the types
type MoveIntent = typeof MoveIntent.type;
type ShootIntent = typeof ShootIntent.type;
```

### 3. Register Intent Codecs

```ts
import { IntentRegistry } from "./protocol/intent";

const registry = new IntentRegistry();

// Register using auto-generated codecs
registry.register(MoveIntent.kind, MoveIntent.codec);
registry.register(ShootIntent.kind, ShootIntent.codec);
```

### 4. Define Your Game State

```ts
interface GameState {
  players: Record<number, { x: number; y: number; health: number }>;
}
```

### 5. Client: Encode & Send Intents

```ts
// Generate intent from input
const intent: MoveIntent = {
  kind: IntentKind.Move,
  tick: currentTick,
  dx: input.x,
  dy: input.y,
};

// Encode using auto-generated codec
const buf = registry.encode(intent);

// Send to server
socket.send(buf);
```

### 6. Server: Receive & Decode Intents

```ts
socket.on("data", (buf: Uint8Array) => {
  // First byte is always the intent kind
  const kind = buf[0];

  // Decode using registered codec
  const intent = registry.decode(kind, buf);

  // Process intent in your game logic
  processIntent(intent);
});
```

### 7. Server: Create & Send Snapshots

```ts
import { SnapshotCodec } from "./protocol/snapshot";
import { PooledCodec } from "./core/pooled-codec";

// Create codec for state updates (same schema as your state)
const stateCodec = new PooledCodec({
  players: // your state schema here
});

const snapshotCodec = new SnapshotCodec(stateCodec);

// After processing intents, create a snapshot
const snapshot: Snapshot<GameState> = {
  tick: serverTick,
  updates: {
    // Only include what changed
    players: {
      1: { x: 10, y: 20, health: 90 },
      2: { x: 15, y: 25 }, // health unchanged
    },
  },
};

// Encode and send (zero allocation)
const buf = snapshotCodec.encode(snapshot);
socket.send(buf);
```

### 8. Client: Decode & Apply Snapshots

```ts
import { applySnapshot } from "./protocol/snapshot";

socket.on("snapshot", (buf: Uint8Array) => {
  // Decode snapshot
  const snapshot = snapshotCodec.decode(buf);

  // Deep merge updates into client state
  applySnapshot(clientState, snapshot);

  // Render updated state
  render(clientState);
});
```

## Type Safety Benefits

Using `defineIntent` with enums gives you:

✅ **Single Source of Truth** - Type and schema defined together
✅ **Zero Drift** - TypeScript type automatically matches binary schema
✅ **Automatic Fields** - `kind` and `tick` added automatically
✅ **Named Constants** - `IntentKind.Move` instead of magic numbers
✅ **IDE Support** - Full autocomplete and refactoring
✅ **Compile-time Safety** - Catch errors before runtime

### Before (Manual)
```ts
// Define interface
interface MoveIntent extends Intent {
  kind: 1;  // Can drift from registration
  tick: number;
  dx: number;
  dy: number;
}

// Define schema separately (can drift from interface!)
registry.register(1, new PooledCodec({
  kind: BinaryCodec.u8,
  tick: BinaryCodec.u32,
  dx: BinaryCodec.f32,
  dy: BinaryCodec.f32,  // Wait, should this be f64?
}));
```

### After (defineIntent)
```ts
// Everything in one place - impossible to drift!
const MoveIntent = defineIntent({
  kind: IntentKind.Move,
  schema: {
    dx: BinaryCodec.f32,
    dy: BinaryCodec.f32,
  }
});

type MoveIntent = typeof MoveIntent.type;
registry.register(MoveIntent.kind, MoveIntent.codec);
```

## Memory Efficiency

The codecs are optimized for zero allocations:

```ts
// Encoding
const buf = registry.encode(intent);
socket.send(buf);

// Decoding
const decoded = registry.decode(kind, buf);
processIntent(decoded);
```

**Efficient binary encoding** with minimal allocations.

## Snapshot Deep Merging

`applySnapshot` intelligently merges nested updates:

```ts
const state: GameState = {
  players: {
    1: { x: 0, y: 0, health: 100 },
    2: { x: 10, y: 10, health: 100 },
  },
};

const snapshot: Snapshot<GameState> = {
  tick: 100,
  updates: {
    players: {
      1: { x: 5 }, // Only update x, keep y and health
    },
  },
};

applySnapshot(state, snapshot);

// Result:
// state.players[1] = { x: 5, y: 0, health: 100 }
// state.players[2] unchanged
```

- **Objects**: Deep merged
- **Arrays**: Replaced entirely
- **Primitives**: Overwritten

## Efficient Partial Updates with SnapshotRegistry

For games with many state fields, use `SnapshotRegistry` to send only specific update types.

**Note:** Unlike intents (which use `defineIntent`), snapshots currently use manual codec definition with `PooledCodec`. A `defineSnapshot` helper may be added in the future for consistency.

```ts
import { SnapshotRegistry } from "./protocol/snapshot";
import { PooledCodec } from "./core/pooled-codec";
import { BinaryCodec } from "./core/binary-codec";

// Define separate snapshot update types
interface PlayerUpdate {
  players: Array<{ entityId: number; x: number; y: number }>;
}

interface ScoreUpdate {
  score: number;
}

interface ProjectileUpdate {
  projectiles: Array<{ id: number; x: number; y: number }>;
}

type GameUpdate = PlayerUpdate | ScoreUpdate | ProjectileUpdate;

// Create registry for different snapshot types
const snapshotRegistry = new SnapshotRegistry<GameUpdate>();

// Register codecs for each snapshot type
// (Manual definition - no defineSnapshot helper yet)
snapshotRegistry.register("players", new PooledCodec({
  players: {
    // Define your array schema here
    // See PooledCodec documentation for array schemas
  }
}));

snapshotRegistry.register("score", new PooledCodec({
  score: BinaryCodec.u32
}));

snapshotRegistry.register("projectiles", new PooledCodec({
  projectiles: {
    // Define your array schema here
  }
}));

// Server: Send only what changed (efficient!)
if (playersChanged) {
  const buf = snapshotRegistry.encode("players", {
    tick: 100,
    updates: { players: [{ entityId: 1, x: 5, y: 10 }] }
  });
  socket.send(buf);
}

if (scoreChanged) {
  const buf = snapshotRegistry.encode("score", {
    tick: 100,
    updates: { score: 50 }
  });
  socket.send(buf);
}

// Client: Decode and apply
socket.on("snapshot", (buf: Uint8Array) => {
  const { type, snapshot } = snapshotRegistry.decode(buf);
  applySnapshot(clientState, snapshot);
});
```

**Benefits:**
- ✅ Only encode fields that changed (true partial updates)
- ✅ No bandwidth wasted on nil/empty values
- ✅ Type ID embedded in message (1 byte overhead)
- ✅ Works with arrays, Records, primitives

## Multiple Intents

You can have as many intent types as needed:

```ts
// Define all your intent kinds in one enum
enum IntentKind {
  Move = 1,
  Shoot = 2,
  Jump = 3,
  UseItem = 4,
  Chat = 5,
}

// Define each intent with its schema
const MoveIntent = defineIntent({
  kind: IntentKind.Move,
  schema: { dx: BinaryCodec.f32, dy: BinaryCodec.f32 }
});

const ShootIntent = defineIntent({
  kind: IntentKind.Shoot,
  schema: { targetId: BinaryCodec.u32 }
});

const JumpIntent = defineIntent({
  kind: IntentKind.Jump,
  schema: { height: BinaryCodec.f32 }
});

// Register all at once
registry.register(MoveIntent.kind, MoveIntent.codec);
registry.register(ShootIntent.kind, ShootIntent.codec);
registry.register(JumpIntent.kind, JumpIntent.codec);
```

## RPCs (Remote Procedure Calls)

For one-off events that don't fit intents (inputs) or snapshots (state sync), use RPCs.

### When to Use RPCs

**✅ Use RPCs for:**
- Meta-game events (achievements, notifications)
- Match lifecycle (countdown, match end, pause)
- Chat messages (transient communication)
- UI feedback (purchase confirmations, errors)
- System announcements

**❌ Don't use RPCs for:**
- Game state (use **Snapshots** instead)
- Player inputs (use **Intents** instead)
- Anything that needs persistence or late joiners need to know

### Define RPCs

```ts
import { defineRPC, RpcRegistry } from "./protocol/rpc";
import { BinaryCodec } from "./core/binary-codec";

// Server → Client RPC
const MatchCountdown = defineRPC({
  method: 'matchCountdown',
  schema: {
    secondsRemaining: BinaryCodec.u8,
  }
});

// Client → Server RPC
const BuyItem = defineRPC({
  method: 'buyItem',
  schema: {
    itemId: BinaryCodec.string(32),
  }
});

type MatchCountdown = typeof MatchCountdown.type;
type BuyItem = typeof BuyItem.type;
```

### Register RPCs

```ts
const rpcRegistry = new RpcRegistry();
rpcRegistry.register(MatchCountdown);
rpcRegistry.register(BuyItem);
```

### Client: Send & Receive RPCs

```ts
// Send RPC to server
client.sendRpc(BuyItem, { itemId: 'long_sword' });

// Receive RPC from server
client.onRpc(MatchCountdown, (rpc) => {
  console.log(`Match starting in ${rpc.secondsRemaining}s`);
  showCountdownUI(rpc.secondsRemaining);
});
```

### Server: Send & Receive RPCs

```ts
// Receive RPC from client
server.onRpc(BuyItem, (peerId, rpc) => {
  const player = getPlayer(peerId);
  if (player.gold >= getItemCost(rpc.itemId)) {
    player.items.push(rpc.itemId);
    player.gold -= getItemCost(rpc.itemId);
  }
});

// Send RPC to specific client
server.sendRpc(peerId, MatchCountdown, { secondsRemaining: 10 });

// Broadcast RPC to all clients
server.sendRpcBroadcast(MatchCountdown, { secondsRemaining: 3 });
```

**Note:** RPCs use `MessageType.CUSTOM (0xff)` and are fully integrated with rate limiting, backpressure handling, and buffer pooling.

## What You Build Yourself

This layer intentionally **does not** provide:

- ❌ Game loops (use `FixedTicker` from core)
- ❌ Intent queuing/buffering (application-specific)
- ❌ Snapshot storage/history (application-specific)
- ❌ Network transport (WebSocket, WebRTC, etc.)
- ❌ Prediction/rollback (use `IntentTracker` and `Reconciliator` from core)
- ❌ Interpolation (application-specific)
- ❌ Lag compensation (application-specific)

The protocol layer gives you type-safe codecs. Core utilities like `FixedTicker`, `IntentTracker`, and `Reconciliator` are available separately.

## Testing

```bash
npm test -- intent-registry
```

## License

MIT

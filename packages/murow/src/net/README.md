# Network Layer (`@mococa/net`)

Transport-agnostic networking layer for multiplayer games. Provides generic client/server abstractions that work with any transport (WebSocket, WebRTC, UDP, Socket.io, etc.)

## Key Features

- **Per-Peer Snapshot Registries** - Each player gets their own snapshot codec, enabling:
  - Fog of war (only send visible entities)
  - Interest management (only send relevant data)
  - Player-specific compression/optimization

- **Transport Agnostic** - Pluggable transport adapters for:
  - Bun WebSocket (included)
  - Browser WebSocket
  - WebRTC
  - UDP
  - Socket.io
  - Custom transports

- **Type-Safe Protocol** - Integrates with `@mococa/protocol`:
  - Intent encoding/decoding (client inputs)
  - Snapshot encoding/decoding (state sync)
  - RPC encoding/decoding (one-off events)
  - Binary serialization

- **Connection Lifecycle** - Built-in handling for:
  - Connection/disconnection events
  - Per-peer state tracking
  - Message routing

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│ Game Client │                    │ Game Server │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  Intents (MoveIntent)            │
       ├─────────────────────────────────>│
       │                                  │
       │  Snapshots (GameState)           │
       │<─────────────────────────────────┤
       │                                  │
       │  RPCs (BuyItem)                  │
       ├─────────────────────────────────>│
       │                                  │
       │  RPCs (MatchCountdown)           │
       │<─────────────────────────────────┤
       │                                  │
       ▼                                  ▼
┌─────────────┐                    ┌─────────────┐
│ ClientNetwork│                   │ServerNetwork│
│   Class     │                    │   Class     │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  Binary Messages (Uint8Array)    │
       ├─────────────────────────────────>│
       │<─────────────────────────────────┤
       │                                  │
       ▼                                  ▼
┌─────────────┐                    ┌─────────────┐
│ Transport   │                    │ Transport   │
│ Adapter     │◄──────WebSocket───►│ Adapter     │
└─────────────┘                    └─────────────┘
```

## Quick Start

### 1. Define Your Game Protocol

```typescript
import { BinaryCodec, defineIntent, IntentRegistry, SnapshotRegistry } from 'murow';

// Define intents (client -> server)
enum IntentKind {
  Move = 1,
  Attack = 2,
}

const MoveIntent = defineIntent({
  kind: IntentKind.Move,
  schema: {
    dx: BinaryCodec.f32,
    dy: BinaryCodec.f32,
  }
});

// Define game state (server -> client)
const GameStateCodec = BinaryCodec.object({
  players: BinaryCodec.record(BinaryCodec.string, BinaryCodec.object({
    x: BinaryCodec.f32,
    y: BinaryCodec.f32,
    health: BinaryCodec.u8,
  })),
  tick: BinaryCodec.u32,
});
```

### 2. Create Server

```typescript
import { ServerNetwork, BunWebSocketServerTransport } from 'murow';

// Create transport
const transport = BunWebSocketServerTransport.create(3000);

// Create intent registry
const intentRegistry = new IntentRegistry();
intentRegistry.register(IntentKind.Move, MoveIntent.codec);

// Create server with per-peer snapshot registry factory
const server = new ServerNetwork({
  transport,
  intentRegistry,
  createPeerSnapshotRegistry: () => {
    // Factory called for each new peer connection
    const registry = new SnapshotRegistry();
    registry.register('GameState', GameStateCodec);
    return registry;
  },
  config: { debug: true }
});

// Handle intents
server.onIntent(IntentKind.Move, (peerId, intent) => {
  const { dx, dy } = intent as MoveIntent;
  // Update game state...
});

// Broadcast snapshots
setInterval(() => {
  server.broadcastSnapshot('GameState', {
    tick: currentTick++,
    updates: gameState
  });
}, 50); // 20 Hz
```

### 3. Create Client

```typescript
import { ClientNetwork, BunWebSocketClientTransport } from 'murow';

// Connect to server
const transport = await BunWebSocketClientTransport.connect('ws://localhost:3000');

// Create registries
const intentRegistry = new IntentRegistry();
intentRegistry.register(IntentKind.Move, MoveIntent.codec);

const snapshotRegistry = new SnapshotRegistry();
snapshotRegistry.register('GameState', GameStateCodec);

// Create client
const client = new ClientNetwork({
  transport,
  intentRegistry,
  snapshotRegistry,
  config: { debug: true }
});

// Handle snapshots
client.onSnapshot('GameState', (snapshot) => {
  // Apply to local game state
  gameState = applySnapshot(gameState, snapshot);
});

// Send intents
client.sendIntent({
  kind: IntentKind.Move,
  tick: currentTick,
  dx: 1.0,
  dy: 0.5
});
```

## RPCs (Remote Procedure Calls)

For one-off events that don't fit intents (inputs) or snapshots (state sync), use RPCs. See [Protocol README](../protocol/README.md#rpcs-remote-procedure-calls) for full documentation.

### Quick Example

```typescript
import { defineRPC, RpcRegistry } from 'murow';

// Define RPCs
const MatchCountdown = defineRPC({
  method: 'matchCountdown',
  schema: {
    secondsRemaining: BinaryCodec.u8,
  }
});

const BuyItem = defineRPC({
  method: 'buyItem',
  schema: {
    itemId: BinaryCodec.string(32),
  }
});

// Register RPCs
const rpcRegistry = new RpcRegistry();
rpcRegistry.register(MatchCountdown);
rpcRegistry.register(BuyItem);

// Add to client/server config
const client = new ClientNetwork({
  transport,
  intentRegistry,
  snapshotRegistry,
  rpcRegistry, // ← Optional
});

// Client: Send RPC to server
client.sendRpc(BuyItem, { itemId: 'long_sword' });

// Client: Receive RPC from server
client.onRpc(MatchCountdown, (rpc) => {
  showCountdownUI(rpc.secondsRemaining);
});

// Server: Receive RPC from client
server.onRpc(BuyItem, (peerId, rpc) => {
  handlePurchase(peerId, rpc.itemId);
});

// Server: Send RPC to specific client
server.sendRpc(peerId, MatchCountdown, { secondsRemaining: 10 });

// Server: Broadcast RPC to all clients
server.sendRpcBroadcast(MatchCountdown, { secondsRemaining: 3 });
```

**When to use:**
- ✅ Match lifecycle events (countdown, pause, end)
- ✅ Meta-game events (achievements, notifications)
- ✅ Chat messages
- ✅ UI feedback (purchase confirmations, errors)

**When NOT to use:**
- ❌ Game state (use Snapshots)
- ❌ Player inputs (use Intents)
- ❌ Anything late joiners need to know

## Per-Peer Snapshot Registries

The killer feature! Each peer automatically gets their own snapshot registry via the factory function, enabling powerful optimizations:

### Fog of War (Runtime Filtering)

Use `broadcastSnapshotWithCustomization` to filter data per-peer at runtime:

```typescript
server.broadcastSnapshotWithCustomization('GameState', baseSnapshot, (peerId, snapshot) => {
  const player = gameState.players[peerId];

  // Only send visible entities to this player
  const visibleEntities = entities.filter(entity =>
    distance(player, entity) < VISIBILITY_RADIUS
  );

  return {
    tick: snapshot.tick,
    updates: {
      ...snapshot.updates,
      entities: visibleEntities
    }
  };
});
```

### Platform-Specific Encoding (Factory Pattern)

Different clients can use different codecs by customizing the factory:

```typescript
const server = new ServerNetwork({
  transport,
  intentRegistry,
  createPeerSnapshotRegistry: () => {
    // You could inspect peer metadata here to decide which codec to use
    const registry = new SnapshotRegistry();

    // All peers use same codec by default
    // For different codecs per peer, use peer metadata and create
    // registries conditionally in the factory
    registry.register('GameState', GameStateCodec);
    return registry;
  },
});

// To customize per-peer, set metadata on connection:
server.onConnection((peerId) => {
  const userAgent = /* get from transport metadata */;
  server.setPeerMetadata(peerId, 'platform', userAgent.includes('Mobile') ? 'mobile' : 'desktop');

  // Then in factory, check metadata (note: factory runs before onConnection)
  // So you'd need to create registries lazily or use customization method
});
```

**Note**: The factory runs once per peer automatically. For truly dynamic per-peer codecs, use `broadcastSnapshotWithCustomization` to filter/transform data at send time.

## Creating Custom Transports

Implement the `TransportAdapter` interface:

```typescript
import { TransportAdapter, ServerTransportAdapter } from 'murow/net';

// Client-side transport
class MyTransport implements TransportAdapter {
  send(data: Uint8Array): void {
    // Send binary data through your transport
  }

  onOpen?(handler: () => void): void {
    // Register open handler (optional - if omitted, assumes already connected)
  }

  onMessage(handler: (data: Uint8Array) => void): void {
    // Register message handler
  }

  onClose(handler: () => void): void {
    // Register close handler
  }

  close(): void {
    // Close connection
  }
}

// Server-side transport
class MyServerTransport implements ServerTransportAdapter<MyTransport> {
  onConnection(handler: (peer: MyTransport, peerId: string) => void): void {
    // Register connection handler
  }

  onDisconnection(handler: (peerId: string) => void): void {
    // Register disconnection handler
  }

  getPeer(peerId: string): MyTransport | undefined {
    // Get peer by ID
  }

  getPeerIds(): string[] {
    // Get all peer IDs
  }

  close(): void {
    // Close server
  }
}
```

## Message Protocol

Messages are prefixed with a single byte indicating type:

```
┌────────────┬──────────────────────┐
│ Type (u8)  │ Payload (variable)   │
├────────────┼──────────────────────┤
│ 0x01       │ Intent data          │  (Client -> Server)
│ 0x02       │ Snapshot data        │  (Server -> Client)
│ 0xFF       │ Custom data          │  (Bidirectional)
└────────────┴──────────────────────┘
```

This allows the layer to automatically route messages without requiring separate channels.

## API Reference

### `ServerNetwork<TPeer>`

#### Constructor
```typescript
constructor(config: {
  transport: ServerTransportAdapter<TPeer>;
  intentRegistry: IntentRegistry;
  createPeerSnapshotRegistry: () => SnapshotRegistry<TSnapshots>;
  config?: NetworkConfig;
})
```

**Parameters**:
- `transport`: Server transport adapter for connection management
- `intentRegistry`: Registry for decoding client intents
- `createPeerSnapshotRegistry`: Factory function called once per new peer to create their snapshot registry
- `config`: Optional network configuration (debug, rate limits, buffer pooling, etc.)

#### Methods
- `onIntent(kind: number, handler: (peerId: string, intent: unknown) => void)` - Handle specific intent type
- `onConnection(handler: (peerId: string) => void)` - Handle new connections
- `onDisconnection(handler: (peerId: string) => void)` - Handle disconnections
- `sendSnapshotToPeer<T>(peerId: string, type: string, snapshot: Snapshot<T>)` - Send to specific peer
- `broadcastSnapshot<T>(type: string, snapshot: Snapshot<T>, filter?: (peerId: string) => boolean)` - Broadcast to all
- `broadcastSnapshotWithCustomization<T>(type: string, baseSnapshot: Snapshot<T>, customize: (peerId: string, snapshot: Snapshot<T>) => Snapshot<T>)` - Broadcast with per-peer customization
- `getPeerIds()` - Get all connected peer IDs
- `getPeerState(peerId: string)` - Get peer state
- `setPeerMetadata(peerId: string, key: string, value: unknown)` - Update peer metadata
- `close()` - Close server

### `ClientNetwork`

#### Constructor
```typescript
constructor(config: {
  transport: TransportAdapter;
  intentRegistry: IntentRegistry;
  snapshotRegistry: SnapshotRegistry;
  config?: NetworkConfig;
})
```

#### Methods
- `sendIntent(intent: unknown)` - Send intent to server
- `onSnapshot<T>(type: string, handler: (snapshot: Snapshot<T>) => void)` - Handle specific snapshot type
- `onAnySnapshot(handler: (type: string, snapshot: Snapshot<unknown>) => void)` - Handle all snapshots
- `onClose(handler: () => void)` - Handle connection close
- `getLastReceivedTick()` - Get last received tick number
- `isConnected()` - Check connection status
- `close()` - Close connection

## Examples

See [examples/multiplayer-game.ts](../../examples/multiplayer-game.ts) for a complete working example with:
- Server setup with per-peer registries
- Client prediction
- Multiple intent types
- Fog of war implementation
- Movement, combat, and chat

## Best Practices

1. **Provide a snapshot registry factory** - Required parameter in ServerNetwork constructor
2. **Keep snapshots small** - Only send delta updates (use `Partial<T>` for snapshot.updates)
3. **Use fog of war** - Filter data with `broadcastSnapshotWithCustomization`
4. **Handle disconnections** - Clean up game state in `onDisconnection` handlers (registries auto-cleaned)
5. **Rate limit snapshots** - Typical game tick rates: 10-25 Hz (don't exceed 60Hz)
6. **Validate intents** - Always sanitize/validate data from clients (see validators)
7. **Use tick numbers** - Include tick in intents for prediction/rollback
8. **Transport buffer copying** - Custom transports MUST copy buffers in `send()` if queuing internally

## Performance Tips

- Use pooled codecs for zero-allocation encoding
- Batch snapshot updates when possible
- Implement delta compression for large states
- Use binary encoding (not JSON!)
- Consider different update rates for different data (e.g., position vs. health)
- Profile your snapshot sizes - aim for < 1KB per snapshot

## Current Features

Already implemented:
- ✅ Message priority/ordering (priority queue with backpressure)
- ✅ Bandwidth tracking (per-peer bandwidth monitoring)
- ✅ Rate limiting (configurable maxMessagesPerSecond)
- ✅ Buffer pooling (zero-copy message wrapping)
- ✅ Heartbeat/timeout detection (automatic disconnection)
- ✅ Intent validators (composable validation)

## Future Enhancements

Potential additions:
- Reliable message channels (with acks/retries)
- Automatic compression (LZ4/Zstd)
- Latency measurement (RTT tracking)
- Built-in lag compensation helpers
- Delta compression for snapshots
- Connection migration/reconnection

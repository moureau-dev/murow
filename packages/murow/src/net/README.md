# Network Layer (`murow/net`)

Transport and wire primitives for multiplayer games. This is the agnostic base:
no ECS, no renderer, no game authority.

The opinionated ECS backend is [`murow/netcode`](../../netcode).

## Layers

```
murow/protocol   typed intents, snapshots, RPCs
        ↑
murow/net        transport adapters + wire frames + sessions
        ↑
murow/netcode    ECS game backend: prediction, interest, snapshots
```

## Transports

Implement `TransportAdapter` for a client connection and
`ServerTransportAdapter` for a server that owns peers:

```ts
import type { TransportAdapter, ServerTransportAdapter } from 'murow/net';

class MyClientTransport implements TransportAdapter {
  send(data: Uint8Array): void { /* ... */ }
  onMessage(handler: (data: Uint8Array) => void): void { /* ... */ }
  onClose(handler: () => void): void { /* ... */ }
  close(): void { /* ... */ }
}

class MyServerTransport implements ServerTransportAdapter<MyClientTransport> {
  onConnection(handler: (peer: MyClientTransport, peerId: string) => void): void { /* ... */ }
  onDisconnection(handler: (peerId: string) => void): void { /* ... */ }
  getPeer(peerId: string): MyClientTransport | undefined { /* ... */ }
  getPeerIds(): string[] { /* ... */ }
  close(): void { /* ... */ }
}
```

**Buffer rule:** if a transport queues or retains the buffer after `send()`
returns, it must copy it. The caller may reuse the buffer immediately.

## Bundled transports

| Transport | Import |
|---|---|
| Bun WebSocket server/client | `murow/net` |
| Browser WebSocket client | `murow/net/adapters/browser-websocket` |
| In-memory test transport | `murow/net` |
| Virtual network (latency, jitter, loss, reorder) | `murow/net` |

`VirtualNetwork` / `VirtualServerTransport` are deterministic and seedable. Use
them for netcode and transport tests.

## Wire

`murow/net/wire` owns the packet envelope and session identity:

```ts
import { ServerMessage, packet, packetType, packetPayload, SessionRegistry } from 'murow/net/wire';

const pkt = packet(ServerMessage.Snapshot, payload);
pkt[0];                       // ServerMessage.Snapshot
packetType(pkt);              // ServerMessage.Snapshot
packetPayload(pkt);           // payload view

const sessions = new SessionRegistry<{ entity: number }>();
const token = sessions.createToken();
sessions.hold({ token, data: { entity: 7 }, graceMs: 5000, onExpire: () => { /* expired */ } });
sessions.resume(token);       // { entity: 7 } or undefined
```

- `ServerMessage` and `ClientMessage` are the only wire kind tables.
- `packet` / `packetU32` build a packet. `packetType` / `packetPayload` read one.
- `SessionRegistry` creates unpredictable tokens, holds a disconnected
  session for a grace period, and resumes it. Held records live in a `SlotMap`;
  `resume` scans the small held set instead of using a string-keyed `Map`.

There is no UDP adapter yet. The wire layer is where fragmentation, channels,
acknowledgements, and MTU limits will live when it lands.

## Optional ECS helpers

`murow/net` may use ECS for optional calculations, but only under
`murow/net/ecs`, which is not re-exported by the default `murow/net` entry.
Transport and wire entries stay ECS-free, so a user who never touches ECS never
pulls it in.

## What is not here

- No `ServerNetwork` / `ClientNetwork`. They were a parallel stack and have been
  removed. Use `GameServer` / `GameClient` from `murow/netcode`.
- No snapshots, prediction, rollback, interest, or entity assignment. Those are
  netcode concerns.
- No message priority queue, rate limiter, or heartbeat. Those are transport
  policy and will return in the wire layer when there is a consumer.

## Testing

```ts
import { VirtualNetwork, VirtualServerTransport } from 'murow/net';

const vnet = new VirtualNetwork();
const transport = new VirtualServerTransport({
  vnet,
  seed: 42,
  cfg: { baseLatencyMs: 60, jitterMs: 10, lossChance: 0.02, reorderChance: 0.01 },
});
```

`MemoryServerTransport` is the zero-latency equivalent.

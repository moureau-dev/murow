# Messages

Custom (non-entity) messages for `murow/netcode`, declared with `defineSnapshots`.

Entity snapshots carry scalar components only. Use messages for anything else: tile grids, region lists, arrays of records.

## Define

```ts
import { defineSnapshots, arrayOf } from 'murow/netcode';

const snapshots = defineSnapshots({
  tiles:     { cells: arrayOf({ index: u32, owner: u16 }) },
  neighbors: { ids:   arrayOf({ id: u32 }) },
  match:     { phase: u8, score: u32 },
});
```

Each entry is a plain field schema; the pooled codec is built internally. `arrayOf(...)` builds a variable-length array field. Pass the result as `protocol.snapshots` to both `GameServer` and `GameClient`.

## Send and receive

```ts
server.sendMessageToPeer(peer, 'tiles', { cells });
server.broadcastMessage('tiles', { cells });
client.sendMessage('tiles', { cells });

server.on('message', ({ peer, name, payload }) => { /* ... */ });
client.on('message', ({ name, payload }) => { /* ... */ });
```

`name` and `payload` are typed against the schema map (a discriminated union, like the `'rpc'` event).

## The three channels

| define | direction | shape | role |
|---|---|---|---|
| `defineIntents` | client to server | fixed | inputs, replayed on rollback |
| `defineRpcs` | both | fixed | one-off events |
| `defineSnapshots` | both | fixed or arrays | typed messages; the only channel with `arrayOf` |

Intents and RPCs use `BinaryCodec` (fixed-size fields), so `arrayOf` is not available there. Messages use `PooledCodec`, which supports variable-length arrays.

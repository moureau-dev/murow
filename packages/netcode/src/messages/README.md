# Messages

Custom (non-entity) messages for `murow/netcode`, declared with `defineSnapshots`.

Entity snapshots carry scalar components only. Use messages for anything else: tile grids, region lists, arrays of records.

## Define

```ts
import { defineSnapshots, arrayOf } from 'murow/netcode';

const snapshots = defineSnapshots({
  tiles:     baseline({ cells: arrayOf({ index: u32, owner: u16 }) }),  // state -> replayed on join
  neighbors: baseline({ ids:   arrayOf({ id: u32 }) }),
  vfx:       { spawns: arrayOf({ kind: u16, x: f32, y: f32 }) },        // transient -> no baseline
});
```

Each entry is a plain field schema (the pooled codec is built internally); `arrayOf(...)` builds a variable-length array field. Wrap a schema in `baseline(...)` to mark it a **baseline channel**: a joining or resuming peer receives its current full state before it is considered initialized (`snapshots.baselineKeys` lists them). Pass the result as `protocol.snapshots` to both `GameServer` and `GameClient`.

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

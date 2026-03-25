# Pooled Binary Codec

A small library for efficiently encoding and decoding structured binary data in multiplayer games, with object pooling to minimize allocations.

## Features

* Reusable **object pool** for any type.
* **PooledEncoder / PooledDecoder** for single objects.
* **PooledArrayDecoder / PooledArrayEncoder** for arrays of objects.
* **PooledCodec**: combined encoder + decoder for easy bidirectional use.
* Supports primitive types (`u8`, `u16`, `i32`, `f32`, etc.), vectors, colors, booleans, and strings.
* Automatically initializes objects using `toNil()` from the field schema.

## Installation

```ts
import { PooledCodec, PooledArrayDecoder } from "./pooled-codec.ts";
import { BinaryPrimitives } from "./binary-primitives.ts";
```

## Usage Example

```ts
// Define a position schema
const PositionSchema = {
  x: BinaryPrimitives.f32,
  y: BinaryPrimitives.f32,
};

// Define a snapshot schema using pooled arrays
const PositionsCodec = new PooledCodec(PositionSchema);

const SnapshotSchema = {
  tick: BinaryPrimitives.u16,
  updates: {
    positions: PositionsCodec,
    target: {
      id: BinaryPrimitives.u32,
      name: BinaryPrimitives.string(32),
    },
  },
};

// Create pooled codec for snapshots
const snapshotCodec = new PooledCodec(SnapshotSchema);

// Encode
const buffer = snapshotCodec.encode({
  tick: 42,
  updates: {
    positions: [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
    target: { id: 1, name: "Player1" },
  },
});

// Decode
const snapshot = snapshotCodec.decode(buffer);

// Release pooled objects
snapshotCodec.release(snapshot);
```

## Notes

* Use **pooled objects** to reduce garbage collection overhead in fast-paced games.
* Fields with a `toNil()` method are automatically initialized when acquired from the pool.
* Suitable for real-time multiplayer snapshots, intents, and any high-frequency data.

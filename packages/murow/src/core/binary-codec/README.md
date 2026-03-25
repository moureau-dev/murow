# BinaryCodec

A minimal TypeScript library for **schema-driven binary encoding and decoding**.
Supports fixed-size numeric fields with automatic buffer sizing.

---

## Usage

### Define a schema

```ts
import { BinaryCodec } from ".";

type Player = {
  id: number;
  score: number;
};

const playerSchema = {
  id: BinaryCodec.u8,
  score: BinaryCodec.u16,
};
```

### Encode an object

```ts
const data: Player = { id: 1, score: 420 };
const buffer = BinaryCodec.encode(playerSchema, data);

console.log(buffer); // Uint8Array [1, 1, 164] (example)
```

### Decode into an object

```ts
const target: Player = { id: 0, score: 0 };
BinaryCodec.decode(playerSchema, buffer, target);

console.log(target); // { id: 1, score: 420 }
```

---

## Features

* Fixed-size fields (`u8`, `u16`, `f32`)
* Automatic buffer sizing
* Explicit big-endian encoding
* Safe, re-entrant, and concurrent-friendly
* Schema-driven and type-safe

---

## Notes

* Object keys define **field order** in the binary layout.
* Buffer sizes are validated on decode to avoid overflow.
* Works in browsers and Node.js.

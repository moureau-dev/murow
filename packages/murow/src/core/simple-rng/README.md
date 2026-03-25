# SimpleRNG

A deterministic, seedable, zero-allocation pseudo-random number generator using a 32-bit LCG (Linear Congruential Generator).

## Features

- Deterministic and seedable — same seed always produces the same sequence.
- Zero allocations — just mutates a 32-bit integer.
- Faster than `Math.random()` — no system call overhead.
- Ideal for multiplayer (deterministic simulation), replays, particle systems, and procedural generation.

## Usage

```typescript
import { SimpleRNG } from './simple-rng';

const rng = new SimpleRNG(42); // deterministic seed

rng.rand();           // float in [0, 1)
rng.range(10, 20);    // float in [10, 20)
rng.int(0, 5);        // integer in [0, 5] inclusive
rng.chance(0.3);      // true 30% of the time
rng.pick(['a', 'b']); // random element

rng.seed(42);         // reset to reproduce the sequence
```

## API

- `rand(): number` — Float in [0, 1).
- `range(min, max): number` — Float in [min, max).
- `int(min, max): number` — Integer in [min, max] inclusive.
- `chance(probability): boolean` — True with given probability (0-1).
- `pick(array): T` — Random element from an array.
- `seed(value): void` — Reset the generator to a new seed.

# Raycast

Casts a ray against a set of entities and ranks the hits. Pure CPU and source-agnostic — the same `Raycaster` runs against an ECS on a headless server or a render world on the client. Pairs with [`../hitbox`](../hitbox) (the shapes) and [`../ray`](../ray) (the ray math).

## `Raycaster`

`lookup` supplies the candidate ids and how to resolve each one's hitbox; `configure` supplies how to read each id's transform. Both carry all world knowledge as closures, so the raycaster depends on neither an ECS nor a renderer. It owns a reused hit buffer — `cast` allocates nothing per entity.

```ts
import { Raycaster } from 'murow';
import { Ray3D } from 'murow';

const caster = new Raycaster()
  .lookup({
    query:  () => world.query(Position, Scale, Hitbox), // candidate ids (a plain array)
    hitbox: (e) => lib.at(arch[e]),                     // id → Hitbox | null (null skips)
  })
  .configure({
    position: () => world.fields(Position),             // { x, y, z } field arrays
    scale:    () => world.fields(Scale),
  });

const ray = new Ray3D();
ray.set(eyeX, eyeY, eyeZ, aimX, aimY, aimZ);

const top = caster.cast(ray).hit({ filter: (e) => e !== shooter });
// top.handle = entity id, top.part = 'head', top.distance, top.point
caster.cast(ray).hitAll();   // all hits, nearest first (reused array)
```

| Method | Description |
|---|---|
| `lookup({ query, hitbox })` | Wire the candidate source (ids + per-id hitbox resolver) |
| `configure({ position, scale })` | Wire the transform source (per-axis field-array accessors) |
| `cast(ray)` | Test the ray against the configured source; chains to `hit`/`hitAll` |
| `hit(opts?)` | Nearest hit, or `null`. Pool-backed; valid until the next `cast` |
| `hitAll(opts?)` | All hits, nearest first. Reused array; do not retain across casts |

`opts` is `{ filter?: (id) => boolean; maxDistance?: number }`. `cast` throws if `lookup`/`configure` were not called.

Each `cast` is an explicit, caller-driven ray — there is no per-tick `update` and therefore no `memo` (unlike the renderer's `Raycast`, which memoizes a standing query against a refreshed cursor pick).

## `HitBuffer`

The reused store the raycaster ranks hits in — structure-of-arrays, sorted lazily via an index array. Backends push `(handle, sortKey, point, distance?, part?)`; queries write into caller-owned arrays so lifetimes are explicit and the hot path allocates nothing. The sort key and reported `distance` are separate, so a 2D pick can sort by `-layer` (topmost first) while still reporting the real layer.

Most code uses `Raycaster` (or the renderer's `raycast`) rather than `HitBuffer` directly.

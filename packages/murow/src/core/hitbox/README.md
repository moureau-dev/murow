# Hitbox

Named collision shapes for picking and hit detection. Pure CPU — no GPU, no per-instance state — so the same definitions drive client picking, game logic, and a headless server.

A `Hitbox` is a set of named parts in model-local space, scaled by instance scale at test time. The mode (`'2d'` | `'3d'`) gates the available shapes and accumulates part names into the type.

## `Hitbox`

```ts
import { Hitbox } from 'murow';

// 3D shapes: sphere | box | cylinder
const humanoid = new Hitbox('3d')
  .add('body', { shape: 'cylinder', radius: 50, height: 120, offset: [0, 40, 0] })
  .add('head', { shape: 'sphere', radius: 28, offset: [0, 130, 0] });

// 2D shapes: circle | rect | capsule
const sprite = new Hitbox('2d')
  .add('body', { shape: 'rect', size: [32, 48] });
```

`add(name, shape)` returns a new `Hitbox` whose type carries the added name. Shapes are pure data; `parts` is read at test time.

| Shape (3D) | Fields |
|---|---|
| `sphere` | `radius`, `offset?` |
| `box` | `size: [x,y,z]`, `offset?` |
| `cylinder` | `radius`, `height` (Y-axis), `offset?` |

| Shape (2D) | Fields |
|---|---|
| `circle` | `radius`, `offset?` |
| `rect` | `size: [x,y]`, `offset?` |
| `capsule` | `radius`, `length` (Y-axis), `offset?` |

Single-radius shapes (sphere, cylinder, circle) inflate by the largest relevant scale axis so they enclose a non-uniformly scaled visual rather than clipping inside it. `offset` is model-local and scales too.

## `HitboxLibrary`

The canonical named registry of hitboxes a game uses. Declared once in shared code and read by the renderer, game logic, and server alike.

```ts
import { HitboxLibrary } from 'murow';

const lib = new HitboxLibrary('3d')
  .add('humanoid', humanoid)
  .add('crate', new Hitbox('3d').add('body', { shape: 'box', size: [1, 1, 1] }));

lib.get('humanoid');     // → Hitbox (name autocompletes / typo-checks)
lib.at(0);               // → Hitbox (by index, for ECS components storing a numeric archetype)
lib.indexOf('humanoid'); // → 0
lib.keys();              // → ['humanoid', 'crate']
```

A `PrefabBucket` can be wired to a library with `bucket.hitboxes(lib)`, after which `bucket.add({ ..., hitbox: 'humanoid' })` autocompletes the names.

## Tests

`testHitbox3D` / `testHitbox2D` resolve a hitbox to world space and return the nearest part struck (a reused object) or `null`. `placePart3D` is the shared placement helper (center + half-extents) used by both picking and debug rendering, so the wireframe always matches what is actually picked. `pointInQuad2D` is the default sprite bound when no hitbox is declared.

These are consumed by the `Raycaster` (see [`../raycast`](../raycast)) and, in the WebGPU backend, by `renderer.raycast`.

## Limitations

Hitboxes are static model-space volumes (position + scale, no rotation/skinning in 3D). This serves hitscan picking and gameplay hit zones (e.g. headshots via a `head` part); it is not bone-accurate. 2D hitboxes do apply the sprite's rotation.

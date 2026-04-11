# Ray

2D and 3D ray classes for intersection testing. Zero allocations per test.

## Classes

### `Ray2D`

```ts
import { Ray2D } from 'murow';

const ray = new Ray2D();
ray.set(0, 0, 1, 0); // origin (0,0), direction +X (normalized automatically)

const t = ray.intersectsCircle(5, 0, 1); // → 4
if (t !== null) {
    const [x, y] = ray.at(t);            // → [4, 0]
}
```

**Methods**

| Method | Description |
|--------|-------------|
| `set(ox, oy, dx, dy)` | Set origin and direction (auto-normalized) |
| `at(t)` | Point along ray at distance `t`. Reuses internal buffer |
| `intersectsSegment(ax, ay, bx, by)` | Ray vs line segment |
| `intersectsCircle(cx, cy, r)` | Ray vs circle |
| `intersectsAABB(minX, minY, maxX, maxY)` | Ray vs axis-aligned box |

---

### `Ray3D`

```ts
import { Ray3D } from 'murow';

const ray = new Ray3D();
ray.set(0, 0, 0, 0, 0, 1); // origin (0,0,0), direction +Z

const t = ray.intersectsSphere(0, 0, 5, 1); // → 4
if (t !== null) {
    const [x, y, z] = ray.at(t);            // → [0, 0, 4]
}
```

**Methods**

| Method | Description |
|--------|-------------|
| `set(ox, oy, oz, dx, dy, dz)` | Set origin and direction (auto-normalized) |
| `at(t)` | Point along ray at distance `t`. Reuses internal buffer |
| `intersectsPlane(nx, ny, nz, d)` | Ray vs plane (n·x = d) |
| `intersectsSphere(cx, cy, cz, r)` | Ray vs sphere |
| `intersectsAABB(minX, minY, minZ, maxX, maxY, maxZ)` | Ray vs axis-aligned box |
| `intersectsTriangle(ax, ay, az, bx, by, bz, cx, cy, cz)` | Ray vs triangle (Möller–Trumbore) |

## Return values

All `intersects*` methods return:
- `number` — parametric distance `t` to the first hit (entry point, or exit if origin is inside)
- `null` — no intersection

`t` can be passed to `ray.at(t)` to get the world-space hit position.

## Usage with cameras

```ts
// 3D picking
renderer.camera.movement = 'grounded';
const ray = renderer.camera.screenToRay(mouseX, mouseY);
const t = ray.intersectsPlane(0, 1, 0, 0); // hit the ground plane (y=0)
if (t !== null) {
    const [wx, wy, wz] = ray.at(t);         // world position clicked
}

// 2D picking
const [wx, wy] = renderer.camera.screenToWorld(mouseX, mouseY);
```

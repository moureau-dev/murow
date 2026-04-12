# NavMesh / Pathfinding Utility

A lightweight navigation system for grid-based and hybrid games.

Supports:

* **Grid A*** pathfinding
* **Line-of-sight graph navigation**
* **Dynamic obstacles**
* **Spatial hashing for fast queries**
* **Circle / Rect / Polygon obstacles**
* **Zero rebuilds unless data changes**

Designed for **games**, not CAD-grade geometry.

---

## Features

* ⚡ **Fast obstacle queries** via spatial hash
* 🧠 **Smart rebuilds** (version-based, no unnecessary work)
* 🧩 **Multiple obstacle types**
* 🧭 **A*** with binary heap
* 🧱 **Grid or graph navigation**
* 🔁 Dynamic obstacle add / move / remove
* 🧪 Deterministic & allocation-safe

---

## Usage

### Create navmesh

```ts
const nav = new NavMesh('grid'); // or 'graph'
```

### Add obstacles

```ts
nav.addObstacle({
  type: 'circle',
  pos: { x: 5, y: 5 },
  radius: 2
});
```

```ts
nav.addObstacle({
  type: 'rect',
  pos: { x: 2, y: 3 },
  size: { x: 4, y: 2 },
});
```

```ts
nav.addObstacle({
  type: 'polygon',
  pos: { x: 10, y: 5 },
  points: [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 1, y: 2 },
  ],
});
```

### Move / remove

```ts
nav.moveObstacle(id, { x: 8, y: 4 });
nav.removeObstacle(id);
```

### Find path

```ts
const path = nav.findPath({
  from: { x: 1, y: 1 },
  to: { x: 10, y: 8 }
});
```

---

## Web Workers (Optional)

For games with many concurrent pathfinding requests (20+ units), enable workers for parallel processing:

### Modes

```ts
// Default: synchronous (workers: false)
const nav = new NavMesh('grid'); // Returns Vec2[]
const path = nav.findPath({ from, to });

// Always use workers (workers: true)
const nav = new NavMesh('grid', { workers: true }); // Returns Promise<Vec2[]>
const path = await nav.findPath({ from, to });

// Auto mode (workers: 'auto')
const nav = new NavMesh('grid', { workers: 'auto' }); // Returns Vec2[] | Promise<Vec2[]>
const result = nav.findPath({ from, to });
const path = result instanceof Promise ? await result : result;
```

### Performance

- **Single path**: Sync mode faster (no worker overhead)
- **20+ parallel paths**: Workers ~3x faster
- **30+ unit RTS**: Workers ~4.5x faster (35 FPS → 162 FPS)

Use workers for RTS/strategy games with many simultaneous pathfinding requests.

```ts
// Custom pool size (default: 4)
const nav = new NavMesh('grid', {
  workers: true,
  workerPoolSize: 8,
  workerPath: './custom-worker.js'
});
```

---

## Navigation Modes

### `grid`

* A* over grid cells
* Accurate
* Best for RTS / tactics / tile games

### `graph`

* Line-of-sight check
* Falls back to grid if blocked
* Faster for open maps

---

## Performance

| Feature              | Cost                                        |
| -------------------- | ------------------------------------------- |
| Obstacle point query | **O(1)** avg via spatial hash               |
| Graph LOS check      | **O(dist + candidates)** via DDA traversal  |
| Grid rebuild         | O(n × area)                                 |
| Pathfinding          | O(bᵈ log n)                                 |
| Memory               | Minimal, no allocations per frame           |

Measured (Bun, Intel Core i5-2400, 16 GB DDR3):

| Scenario                        | ms/query |
| ------------------------------- | -------- |
| 50 obstacles,  ~20u path        | 0.0046   |
| 500 obstacles, ~20u path        | 0.0020   |
| 500 obstacles, ~50u path        | 0.0031   |
| 2000 obstacles, ~50u path       | 0.0030   |

Graph LOS cost scales with **path length**, not obstacle count — DDA only visits cells the ray touches.

Handles:

* 1k+ obstacles
* 10k+ A* nodes
* Real-time updates

---

## Notes

* Polygon points **must be local (0,0-based)**
* Rotation is supported for rects & polygons
* All math is deterministic
* No external dependencies (uses `Ray2D` from `murow/core/ray` internally)
